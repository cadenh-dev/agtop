use crate::job_detail::{advance_cursor, events_request, is_terminal, output_request};
use crate::model::{
    Agent, EventsPage, Harness, JobSummary, JobsPage, KillResult, Launch, Lemonade, OutputPage,
};
use anyhow::{Context, Result, bail};
use serde::de::DeserializeOwned;
use std::{
    path::PathBuf,
    sync::mpsc::{self, Receiver, Sender},
    time::{Duration, Instant},
};

pub struct Config {
    pub port: u16,
    pub token_file: PathBuf,
}
impl Config {
    pub fn from_args() -> Result<Self> {
        let mut port = 13309;
        let mut token_file = None;
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--port" => port = args.next().context("Missing --port")?.parse()?,
                "--token-file" => {
                    token_file = Some(PathBuf::from(args.next().context("Missing --token-file")?))
                }
                _ => bail!("Unknown option: {arg}. Use --port PORT --token-file PATH."),
            }
        }
        if port == 0 {
            bail!("The desktop client needs a nonzero daemon port.");
        }
        let state = std::env::var_os("AGTOP_STATE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let base = std::env::var_os("LOCALAPPDATA")
                    .or_else(|| std::env::var_os("XDG_STATE_HOME"))
                    .map(PathBuf::from)
                    .unwrap_or_else(|| {
                        PathBuf::from(
                            std::env::var_os("HOME")
                                .or_else(|| std::env::var_os("USERPROFILE"))
                                .unwrap_or_default(),
                        )
                        .join(".local/state")
                    });
                base.join("agtop")
            });
        Ok(Self {
            port,
            token_file: token_file.unwrap_or_else(|| state.join(format!("daemon-{port}.token"))),
        })
    }
}

#[derive(Debug)]
pub struct HttpStatusError {
    pub status: u16,
    pub message: String,
}

impl std::fmt::Display for HttpStatusError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for HttpStatusError {}

struct Client {
    base: String,
    token_file: PathBuf,
    http: ureq::Agent,
}
impl Client {
    fn new(config: Config) -> Self {
        let http = ureq::Agent::config_builder()
            .proxy(None)
            .timeout_global(Some(Duration::from_secs(25)))
            .max_redirects(0)
            .http_status_as_error(false)
            .build()
            .into();
        Self {
            base: format!("http://127.0.0.1:{}", config.port),
            token_file: config.token_file,
            http,
        }
    }
    fn auth(&self) -> Result<String> {
        let token = std::fs::read_to_string(&self.token_file)
            .context("Cannot read daemon token. Start with agtop ui, or run agtop daemon first.")?;
        let token = token.trim();
        if token.len() < 24 || !token.is_ascii() || token.contains(['\r', '\n']) {
            bail!("Invalid daemon token file.");
        }
        Ok(format!("Bearer {token}"))
    }
    fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        let mut response = self
            .http
            .get(format!("{}{path}", self.base))
            .header("Authorization", &self.auth()?)
            .call()?;
        let status = response.status();
        if !status.is_success() {
            // Surface the daemon's error text. The token never appears in a response body.
            let text = response
                .body_mut()
                .with_config()
                .limit(64 * 1024)
                .read_to_string()
                .unwrap_or_default();
            let message = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|body| {
                    body.get("error")
                        .and_then(|error| error.as_str())
                        .map(str::to_owned)
                })
                .unwrap_or_else(|| format!("Daemon returned HTTP {}.", status.as_u16()));
            return Err(HttpStatusError {
                status: status.as_u16(),
                message,
            }
            .into());
        }
        Ok(response
            .body_mut()
            .with_config()
            .limit(32 * 1024 * 1024)
            .read_json()?)
    }
    fn post<T: DeserializeOwned>(&self, path: &str, value: serde_json::Value) -> Result<T> {
        let mut response = self
            .http
            .post(format!("{}{path}", self.base))
            .header("Authorization", &self.auth()?)
            .send_json(value)?;
        let status = response.status();
        let body: serde_json::Value = response
            .body_mut()
            .with_config()
            .limit(1024 * 1024)
            .read_json()?;
        if !status.is_success() {
            bail!(
                "{}",
                body.get("error")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned)
                    .unwrap_or_else(|| body.to_string())
            );
        }
        Ok(serde_json::from_value(body)?)
    }
}

pub enum Command {
    Refresh,
    Stop {
        id: String,
        start_time: String,
    },
    Launch(Launch),
    /// Some(id): start polling this job's output and events. None: stop.
    WatchJob(Option<String>),
}
pub enum Event {
    Snapshot(Vec<Agent>),
    Jobs(Vec<JobSummary>),
    Harnesses(Vec<Harness>),
    Lemonade(Lemonade),
    Error(String),
    Completed(String),
    Launched(String),
    JobOutput { id: String, page: OutputPage },
    JobEvents { id: String, page: EventsPage },
    JobDetailUnavailable { id: String, message: String },
}

pub fn start(config: Config) -> (Sender<Command>, Receiver<Event>) {
    let (send_command, commands) = mpsc::channel();
    let (events, receive_event) = mpsc::channel();
    std::thread::spawn(move || {
        let client = Client::new(config);
        if let Ok(catalog) = client.get::<Vec<Harness>>("/v1/harnesses") {
            let _ = events.send(Event::Harnesses(catalog));
        }
        let mut next_probe = Instant::now();
        let mut first = true;
        let mut watched: Option<(String, u64, u64)> = None;
        loop {
            let command = if first {
                first = false;
                Ok(Command::Refresh)
            } else if watched.is_some() {
                commands.recv_timeout(Duration::from_secs(1))
            } else {
                commands.recv_timeout(Duration::from_secs(2))
            };
            let action: Result<Option<Event>> = match command {
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) | Ok(Command::Refresh) => Ok(None),
                Ok(Command::WatchJob(id)) => {
                    watched = id.map(|id| (id, 0, 0));
                    Ok(None)
                }
                Ok(Command::Stop { id, start_time }) => (|| {
                    let current: Vec<Agent> = client.get("/v1/agents")?;
                    let target = current
                        .iter()
                        .find(|a| a.job_id == id)
                        .context("This job has already exited.")?;
                    if target.identity().1 != start_time {
                        bail!(
                            "The process identity changed. Select the current job before stopping it."
                        );
                    }
                    let result: KillResult = client.post(
                        &format!("/v1/agents/{}/kill", encode_segment(&id)),
                        serde_json::json!({ "expectedStartTime": start_time }),
                    )?;
                    if !result.failed_pids.is_empty() || !result.errors.is_empty() {
                        bail!(
                            "Some processes could not be stopped: {:?} {}",
                            result.failed_pids,
                            result.errors.join("; ")
                        );
                    }
                    Ok(Some(Event::Completed(format!(
                        "Stopped {} processes.",
                        result.killed_pids.len()
                    ))))
                })(),
                Ok(Command::Launch(options)) => (|| {
                    let result: serde_json::Value =
                        client.post("/v1/agents", serde_json::to_value(options)?)?;
                    Ok(Some(Event::Launched(
                        result["jobId"]
                            .as_str()
                            .context("Missing job ID in launch response")?
                            .to_owned(),
                    )))
                })(),
            };
            match action {
                Ok(Some(event)) => {
                    let _ = events.send(event);
                }
                Err(e) => {
                    let _ = events.send(Event::Error(format!("{e:#}")));
                }
                _ => {}
            }
            match client.get("/v1/agents") {
                Ok(agents) => {
                    if let Ok(page) = client.get::<JobsPage>("/v1/jobs?limit=500") {
                        let _ = events.send(Event::Jobs(page.jobs));
                    }
                    if events.send(Event::Snapshot(agents)).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    if events.send(Event::Error(format!("{e:#}"))).is_err() {
                        break;
                    }
                }
            }
            if Instant::now() >= next_probe {
                if let Ok(status) = client.get("/v1/lemonade") {
                    let _ = events.send(Event::Lemonade(status));
                }
                next_probe = Instant::now() + Duration::from_secs(15);
            }
            if let Some((id, output_cursor, event_cursor)) = watched.take() {
                let (output_cursor, event_cursor, keep) =
                    poll_detail(&client, &id, output_cursor, event_cursor, &events);
                if keep {
                    watched = Some((id, output_cursor, event_cursor));
                }
            }
        }
    });
    (send_command, receive_event)
}

/// Bounds the work of one polling tick so a job with a large backlog cannot
/// monopolise the worker. The cursor resumes on the next tick.
const MAX_PAGES_PER_TICK: usize = 20;

fn poll_detail(
    client: &Client,
    id: &str,
    mut output_cursor: u64,
    mut event_cursor: u64,
    events: &Sender<Event>,
) -> (u64, u64, bool) {
    let mut keep = true;
    let mut terminal = false;
    for _ in 0..MAX_PAGES_PER_TICK {
        match client.get::<OutputPage>(&output_request(id, output_cursor)) {
            Ok(page) => {
                terminal |= is_terminal(&page.state);
                let more = page.has_more;
                output_cursor = advance_cursor(output_cursor, page.next_since);
                if events
                    .send(Event::JobOutput {
                        id: id.to_owned(),
                        page,
                    })
                    .is_err()
                {
                    return (output_cursor, event_cursor, false);
                }
                if !more {
                    break;
                }
            }
            Err(error) => {
                keep = detail_failure(&error, id, events);
                break;
            }
        }
    }
    if keep {
        for _ in 0..MAX_PAGES_PER_TICK {
            match client.get::<EventsPage>(&events_request(id, event_cursor)) {
                Ok(page) => {
                    let more = page.has_more;
                    event_cursor = advance_cursor(event_cursor, page.next_since);
                    if events
                        .send(Event::JobEvents {
                            id: id.to_owned(),
                            page,
                        })
                        .is_err()
                    {
                        return (output_cursor, event_cursor, false);
                    }
                    if !more {
                        break;
                    }
                }
                Err(error) => {
                    keep = detail_failure(&error, id, events);
                    break;
                }
            }
        }
    }
    (output_cursor, event_cursor, keep && !terminal)
}

/// Reports a detail request failure. Returns whether the job stays watched.
fn detail_failure(error: &anyhow::Error, id: &str, events: &Sender<Event>) -> bool {
    let status = error
        .downcast_ref::<HttpStatusError>()
        .map(|error| error.status);
    if matches!(status, Some(404 | 409 | 410)) {
        let message = format!("{error:#}");
        let _ = events.send(Event::JobDetailUnavailable {
            id: id.to_owned(),
            message,
        });
        false
    } else {
        let _ = events.send(Event::Error(format!("{error:#}")));
        true
    }
}

pub(crate) fn encode_segment(text: &str) -> String {
    text.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn job_ids_cannot_change_the_request_path() {
        assert_eq!(super::encode_segment("a/b?x"), "a%2Fb%3Fx");
    }
}
