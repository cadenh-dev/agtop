use crate::{
    client::encode_segment,
    model::{EventsPage, JobEvent, OutputChunk, OutputPage, Truncation, TruncationInfo},
    theme::*,
};
use gpui::{Div, ElementId, FontWeight, SharedString, Stateful, div, prelude::*, px};
use std::collections::VecDeque;

/// Newest lines kept for the detail view.
pub const MAX_LINES: usize = 5000;
/// The first output request asks for a tail so a late viewer sees context.
pub const TAIL_LINES: u64 = 500;
pub const PAGE_MAX_BYTES: u64 = 262_144;
pub const EVENT_PAGE_LIMIT: u64 = 200;
const VISIBLE_EVENTS: usize = 20;

/// Output request for the next poll. A zero cursor is the first request.
pub fn output_request(job_id: &str, cursor: u64) -> String {
    let id = encode_segment(job_id);
    if cursor == 0 {
        format!("/v1/jobs/{id}/output?stream=both&tail={TAIL_LINES}&since=0")
    } else {
        format!("/v1/jobs/{id}/output?stream=both&since={cursor}&maxBytes={PAGE_MAX_BYTES}")
    }
}

pub fn events_request(job_id: &str, cursor: u64) -> String {
    format!(
        "/v1/jobs/{}/events?since={cursor}&limit={EVENT_PAGE_LIMIT}",
        encode_segment(job_id)
    )
}

/// `nextSince` is the documented continuation cursor; never move backwards if
/// a daemon replies with a stale value.
pub fn advance_cursor(current: u64, next_since: u64) -> u64 {
    next_since.max(current)
}

/// Terminal states from the job state machine; polling stops once one arrives.
pub fn is_terminal(state: &str) -> bool {
    matches!(state, "exited" | "failed" | "killed" | "lost")
}

/// One marker line per truncated chunk, matching the daemon's text rendering.
pub fn truncation_marker(stream: &str, info: Option<&TruncationInfo>, chunk: &OutputChunk) -> String {
    match info {
        Some(info) => format!(
            "[agtop: {} bytes of {} dropped (seq {}-{})]",
            info.dropped_bytes, stream, info.first_dropped_seq, info.last_dropped_seq
        ),
        None => format!(
            "[agtop: earlier {} output dropped before seq {}]",
            stream,
            chunk.first_dropped_seq.unwrap_or(chunk.seq)
        ),
    }
}

pub fn truncation_summary(truncation: &Truncation) -> Option<String> {
    let parts = [
        ("stdout", truncation.stdout.as_ref()),
        ("stderr", truncation.stderr.as_ref()),
    ]
    .into_iter()
    .filter_map(|(stream, info)| {
        info.map(|info| {
            format!(
                "{stream} dropped {} bytes (seq {}-{})",
                info.dropped_bytes, info.first_dropped_seq, info.last_dropped_seq
            )
        })
    })
    .collect::<Vec<_>>();
    (!parts.is_empty()).then(|| format!("Output truncated: {}", parts.join(" · ")))
}

pub struct JobDetail {
    pub job_id: String,
    pub lines: VecDeque<(String, String)>,
    pub events: Vec<JobEvent>,
    pub truncation: Truncation,
    pub state: String,
    pub exit_code: Option<i64>,
    pub unavailable: Option<String>,
}

impl JobDetail {
    pub fn new(job_id: impl Into<String>) -> Self {
        Self {
            job_id: job_id.into(), lines: VecDeque::new(), events: Vec::new(),
            truncation: Truncation::default(), state: String::new(), exit_code: None, unavailable: None,
        }
    }

    pub fn apply_output(&mut self, page: OutputPage) {
        if page.job_id != self.job_id {
            return;
        }
        for chunk in &page.chunks {
            if chunk.truncated {
                let info = match chunk.stream.as_str() {
                    "stdout" => page.truncation.stdout.as_ref(),
                    "stderr" => page.truncation.stderr.as_ref(),
                    _ => None,
                };
                self.push_line(&chunk.stream, truncation_marker(&chunk.stream, info, chunk));
            }
            // A chunk that is only a newline still renders as one blank line.
            if chunk.data.is_empty() {
                continue;
            }
            let data = chunk.data.strip_suffix('\n').unwrap_or(&chunk.data);
            for line in data.split('\n') {
                // Windows children write CRLF; drop the CR so it never reaches the UI.
                self.push_line(&chunk.stream, line.strip_suffix('\r').unwrap_or(line).to_owned());
            }
        }
        (self.truncation, self.state, self.exit_code) = (page.truncation, page.state, page.exit_code);
    }

    pub fn apply_events(&mut self, page: EventsPage) {
        self.events.extend(page.events);
    }

    fn push_line(&mut self, stream: &str, line: String) {
        self.lines.push_back((stream.to_owned(), line));
        while self.lines.len() > MAX_LINES {
            self.lines.pop_front();
        }
    }
}

fn caption(text: impl Into<SharedString>) -> Div {
    div().text_size(px(12.)).text_color(color(MUTED)).child(text.into())
}

fn scroll_box(id: impl Into<ElementId>, max_height: f32) -> Stateful<Div> {
    div().id(id).max_h(px(max_height)).overflow_y_scroll().p_2().rounded_md().border_1()
        .border_color(color(LINE)).bg(color(BACKGROUND)).text_size(px(11.)).font_family(MONO)
}

/// Detail pane rendered below the process tree.
pub fn render(detail: Option<&JobDetail>, job_id: &str) -> Stateful<Div> {
    let mut pane = div().id("job-detail").mt_5().pt_4().border_t_1().border_color(color(LINE)).flex()
        .flex_col().gap_3()
        .child(div().text_size(px(16.)).font_weight(FontWeight::SEMIBOLD).child("Captured output"));
    let Some(detail) = detail.filter(|detail| detail.job_id == job_id) else {
        return pane.child(caption("Output loads after the first poll."));
    };
    let state = if detail.state.is_empty() { "unknown" } else { detail.state.as_str() };
    let tone = match state {
        "failed" | "killed" | "lost" => DANGER,
        "running" => ACCENT,
        _ => MUTED,
    };
    let exit = detail.exit_code.map(|code| format!("   Exit code: {code}")).unwrap_or_default();
    pane = pane.child(div().text_size(px(13.)).text_color(color(tone)).child(format!("State: {state}{exit}")));
    if let Some(message) = &detail.unavailable {
        return pane.child(div().text_size(px(13.)).text_color(color(DANGER)).child(message.clone()));
    }
    if let Some(summary) = truncation_summary(&detail.truncation) {
        pane = pane.child(caption(summary));
    }

    let mut output = scroll_box("job-output-lines", 220.).flex().flex_col();
    if detail.lines.is_empty() {
        output = output.child(caption("No output captured yet."));
    }
    for (index, (stream, line)) in detail.lines.iter().enumerate() {
        let stderr = stream == "stderr";
        output = output.child(
            div()
                .id(("job-line", index))
                .text_color(color(if stderr { DANGER } else { TEXT }))
                .child(format!("{}  {}", if stderr { "err" } else { "out" }, line)),
        );
    }
    let start = detail.events.len().saturating_sub(VISIBLE_EVENTS);
    let events = detail.events[start..]
        .iter()
        .map(|event| {
            format!(
                "#{} {} {} {}",
                event.seq,
                event.timestamp,
                event.kind,
                event.state.as_deref().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    pane.child(output)
        .child(div().mt_2().text_size(px(16.)).font_weight(FontWeight::SEMIBOLD).child("Events"))
        .child(scroll_box("job-events", 160.).child(events))
}

#[cfg(test)]
mod tests {
    use super::{JobDetail, MAX_LINES, advance_cursor, is_terminal, output_request, truncation_summary};
    use crate::model::{OutputChunk, OutputPage, Truncation, TruncationInfo};

    fn chunk(seq: u64, stream: &str, data: &str) -> OutputChunk {
        OutputChunk { seq, stream: stream.into(), data: data.into(), ..Default::default() }
    }

    fn page(job_id: &str, state: &str, chunks: Vec<OutputChunk>) -> OutputPage {
        OutputPage { job_id: job_id.into(), state: state.into(), chunks, ..Default::default() }
    }

    fn info(first: u64, last: u64, bytes: u64) -> TruncationInfo {
        TruncationInfo { first_dropped_seq: first, last_dropped_seq: last, dropped_bytes: bytes }
    }

    #[test]
    fn apply_output_splits_chunk_data_into_lines_per_stream() {
        let mut detail = JobDetail::new("build-42");
        let chunks = vec![
            chunk(1, "stdout", "one\ntwo\n"),
            chunk(2, "stderr", "bad\n"),
            chunk(3, "stdout", "three"),
        ];
        detail.apply_output(page("build-42", "running", chunks));
        assert_eq!(
            detail.lines.iter().cloned().collect::<Vec<_>>(),
            vec![
                ("stdout".to_owned(), "one".to_owned()), ("stdout".to_owned(), "two".to_owned()),
                ("stderr".to_owned(), "bad".to_owned()), ("stdout".to_owned(), "three".to_owned()),
            ]
        );
        assert_eq!((detail.state.as_str(), detail.exit_code), ("running", None));
    }

    #[test]
    fn apply_output_keeps_the_newest_lines_and_ignores_other_jobs() {
        let mut detail = JobDetail::new("j");
        detail.apply_output(page("other", "running", vec![chunk(1, "stdout", "x\n")]));
        assert!(detail.lines.is_empty() && detail.state.is_empty());
        let data = (0..=MAX_LINES).map(|index| format!("line-{index}\n")).collect::<String>();
        detail.apply_output(page("j", "running", vec![chunk(1, "stdout", &data)]));
        assert_eq!(detail.lines.len(), MAX_LINES);
        assert_eq!(detail.lines.front().unwrap().1, "line-1");
        assert_eq!(detail.lines.back().unwrap().1, format!("line-{MAX_LINES}"));
    }

    #[test]
    fn apply_output_inserts_one_marker_line_for_a_truncated_chunk() {
        let mut detail = JobDetail::new("j");
        let mut page = page("j", "running", vec![chunk(902, "stdout", "after\n")]);
        page.truncation.stdout = Some(info(4, 901, 9_437_214));
        page.chunks[0].truncated = true;
        page.chunks[0].first_dropped_seq = Some(4);
        detail.apply_output(page);
        assert_eq!(detail.lines.len(), 2);
        assert_eq!(
            detail.lines.front().unwrap().1,
            "[agtop: 9437214 bytes of stdout dropped (seq 4-901)]"
        );
        assert_eq!(detail.lines.back().unwrap().1, "after");
    }

    #[test]
    fn truncation_summary_displays_dropped_bytes() {
        let mut truncation = Truncation::default();
        assert!(truncation_summary(&truncation).is_none());
        truncation.stdout = Some(info(4, 901, 100));
        truncation.stderr = Some(info(2, 3, 7));
        let summary = truncation_summary(&truncation).unwrap();
        assert!(summary.starts_with("Output truncated: stdout dropped 100 bytes (seq 4-901)"));
        assert!(summary.ends_with("stderr dropped 7 bytes (seq 2-3)"));
    }

    #[test]
    fn requests_and_cursors_advance_with_next_since() {
        assert_eq!(output_request("build-42", 0), "/v1/jobs/build-42/output?stream=both&tail=500&since=0");
        assert_eq!(output_request("a/b", 918), "/v1/jobs/a%2Fb/output?stream=both&since=918&maxBytes=262144");
        assert_eq!(super::events_request("j", 5), "/v1/jobs/j/events?since=5&limit=200");
        assert_eq!((advance_cursor(918, 921), advance_cursor(900, 10)), (921, 900));
    }

    #[test]
    fn terminal_states_stop_detail_polling() {
        assert!(["exited", "failed", "killed", "lost"].iter().all(|state| is_terminal(state)));
        assert!(["", "queued", "starting", "running", "exiting"].iter().all(|state| !is_terminal(state)));
    }
}
