use crate::{
    client::{Command, Config, Event},
    input::TextInput,
    model::{Agent, Harness, Launch, Lemonade, parse_arguments},
    theme::*,
};
use gpui::{div, prelude::*, *};
use std::{
    rc::Rc,
    sync::mpsc::{Receiver, Sender},
    time::{Duration, Instant},
};

actions!(
    agtop,
    [NextFocus, PreviousFocus, Refresh, NewAgent, Dismiss, Quit]
);

const NEW_AGENT_SHORTCUT: &str = if cfg!(target_os = "macos") {
    "cmd-n"
} else {
    "ctrl-n"
};
const REFRESH_SHORTCUT: &str = if cfg!(target_os = "macos") {
    "cmd-r"
} else {
    "ctrl-r"
};
const QUIT_SHORTCUT: &str = if cfg!(target_os = "macos") {
    "cmd-q"
} else {
    "ctrl-q"
};
const DISMISS_SHORTCUT: &str = "escape";

struct LaunchForm {
    command: Entity<TextInput>,
    args: Entity<TextInput>,
    cwd: Entity<TextInput>,
    harness_search: Entity<TextInput>,
    harness: String,
    lemonade: bool,
}

pub struct Workbench {
    agents: Vec<Agent>,
    harnesses: Vec<Harness>,
    selected: Option<String>,
    filter: u8,
    role_filter: Option<String>,
    search: Entity<TextInput>,
    commands: Sender<Command>,
    events: Receiver<Event>,
    _poll: Task<()>,
    focus: FocusHandle,
    last_success: Option<Instant>,
    error: Option<String>,
    notice: Option<String>,
    busy: bool,
    lemonade: Option<Lemonade>,
    form: Option<LaunchForm>,
    confirm: Option<Agent>,
}

impl Workbench {
    pub fn new(config: Config, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (commands, events) = crate::client::start(config);
        let search =
            cx.new(|cx| TextInput::new("Filter by agent, command, branch, peer or PID", "", cx));
        cx.observe(&search, |_, _, cx| cx.notify()).detach();
        let focus = cx.focus_handle();
        window.focus(&focus);
        let executor = cx.background_executor().clone();
        let poll = cx.spawn(async move |this, cx| {
            loop {
                executor.timer(Duration::from_millis(100)).await;
                if this.update(cx, |this, cx| this.receive(cx)).is_err() {
                    break;
                }
            }
        });
        Self {
            agents: vec![],
            harnesses: fallback_harnesses(),
            selected: None,
            filter: 0,
            role_filter: None,
            search,
            commands,
            events,
            _poll: poll,
            focus,
            last_success: None,
            error: None,
            notice: None,
            busy: false,
            lemonade: None,
            form: None,
            confirm: None,
        }
    }

    fn receive(&mut self, cx: &mut Context<Self>) {
        let mut changed = false;
        while let Ok(event) = self.events.try_recv() {
            changed = true;
            match event {
                Event::Snapshot(mut agents) => {
                    agents.sort_by(|a, b| {
                        b.total_cpu_percent
                            .total_cmp(&a.total_cpu_percent)
                            .then_with(|| a.root_pid.cmp(&b.root_pid))
                    });
                    if let Some(selected) = refreshed_selection(&agents, self.selected.as_deref()) {
                        self.selected = selected;
                        self.confirm = None;
                    }
                    self.agents = agents;
                    if self
                        .role_filter
                        .as_deref()
                        .is_some_and(|role| !keep_role_filter(&self.agents, Some(role)))
                    {
                        self.role_filter = None;
                    }
                    self.last_success = Some(Instant::now());
                }
                Event::Harnesses(catalog) => {
                    if !catalog.is_empty() {
                        self.harnesses = catalog;
                    }
                }
                Event::Lemonade(status) => self.lemonade = Some(status),
                Event::Error(error) => {
                    self.error = Some(error);
                    self.busy = false;
                    self.confirm = None;
                }
                Event::Completed(message) => {
                    self.notice = Some(message);
                    self.error = None;
                    self.busy = false;
                    self.confirm = None;
                }
                Event::Launched(id) => {
                    self.selected = Some(id);
                    self.form = None;
                    self.notice = Some("Agent launched in OS containment.".into());
                    self.error = None;
                    self.busy = false;
                }
            }
        }
        if changed {
            cx.notify();
        }
    }
    fn connected(&self) -> bool {
        self.last_success
            .is_some_and(|t| t.elapsed() < Duration::from_secs(8))
    }
    fn send(&mut self, command: Command) {
        if self.commands.send(command).is_err() {
            self.error = Some("The connection worker stopped. Restart the desktop app.".into());
            self.busy = false;
        }
    }
    fn open_form(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let command =
            cx.new(|cx| TextInput::new(if cfg!(windows) { "cmd.exe" } else { "codex" }, "", cx));
        window.focus(&command.focus_handle(cx));
        let harness_search = cx.new(|cx| TextInput::new("Search by name or kind", "", cx));
        cx.observe(&harness_search, |_, _, cx| cx.notify()).detach();
        self.form = Some(LaunchForm {
            command,
            args: cx.new(|cx| TextInput::new("[]", "[]", cx)),
            cwd: cx.new(|cx| TextInput::new("Leave empty for the manager's directory", "", cx)),
            harness_search,
            harness: "custom".into(),
            lemonade: false,
        });
        self.confirm = None;
        self.error = None;
        cx.notify();
    }
    fn launch(&mut self, cx: &mut Context<Self>) {
        if self.busy || !self.connected() {
            return;
        }
        let Some(form) = &self.form else {
            return;
        };
        let command = form.command.read(cx).content.trim().to_owned();
        if command.is_empty() {
            self.error = Some("Enter the executable to launch.".into());
            cx.notify();
            return;
        }
        let args = match validate_launch_arguments(&form.args.read(cx).content) {
            Ok(args) => args,
            Err(e) => {
                self.error = Some(e);
                cx.notify();
                return;
            }
        };
        let cwd = form.cwd.read(cx).content.trim().to_owned();
        let options = Launch {
            command,
            args,
            cwd: if cwd.is_empty() { None } else { Some(cwd) },
            harness: form.harness.clone(),
            use_lemonade_local: form.lemonade,
        };
        self.busy = true;
        self.error = None;
        self.send(Command::Launch(options));
        cx.notify();
    }
    fn action(
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        primary: bool,
        callback: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let callback = Rc::new(callback);
        let key_callback = callback.clone();
        div()
            .id(id)
            .tab_index(0)
            .flex()
            .items_center()
            .justify_center()
            .h(px(36.))
            .px_3()
            .rounded_md()
            .border_1()
            .border_color(color(if primary { ACCENT } else { LINE }))
            .bg(color(if primary { ACCENT } else { PANEL }))
            .text_color(color(if primary { BACKGROUND } else { TEXT }))
            .text_size(px(13.))
            .font_weight(FontWeight::MEDIUM)
            .cursor_pointer()
            .hover(move |s| s.bg(color(if primary { TEXT } else { RAISED })))
            .focus(|s| s.border_color(color(TEXT)))
            .on_click(cx.listener(move |this, _, window, cx| callback(this, window, cx)))
            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "enter" || event.keystroke.key == "space" {
                    key_callback(this, window, cx);
                    cx.stop_propagation();
                }
            }))
            .child(label.into())
    }
    fn caption(text: impl Into<SharedString>) -> Div {
        div()
            .text_size(px(12.))
            .text_color(color(MUTED))
            .child(text.into())
    }
    fn fact(label: &str, value: impl Into<SharedString>) -> Div {
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(Self::caption(label.to_owned()))
            .child(div().text_size(px(14.)).child(value.into()))
    }
    fn navigation(&self, cx: &Context<Self>) -> Div {
        let managed = self.agents.iter().filter(|a| a.managed()).count();
        let mut roles = crate::model::ROLE_ORDER
            .iter()
            .filter_map(|role| {
                let count: u32 = self
                    .agents
                    .iter()
                    .map(|agent| agent.role_counts.get(*role).copied().unwrap_or(0))
                    .sum();
                (count > 0 || self.role_filter.as_deref() == Some(role)).then_some((*role, count))
            })
            .collect::<Vec<_>>();
        div()
            .w(px(196.))
            .flex_shrink_0()
            .h_full()
            .bg(color(PANEL))
            .border_r_1()
            .border_color(color(LINE))
            .p_5()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .text_size(px(26.))
                    .font_weight(FontWeight::BOLD)
                    .text_color(color(ACCENT))
                    .mb_1()
                    .child("agtop"),
            )
            .child(Self::caption("Agent process manager").mb_6())
            .children(
                [
                    ("All agents", self.agents.len()),
                    ("Managed", managed),
                    ("Discovered", self.agents.len() - managed),
                ]
                .into_iter()
                .enumerate()
                .map(|(index, (name, count))| {
                    Self::action(
                        ("nav", index),
                        format!("{name}   {count}"),
                        self.filter == index as u8,
                        move |this, _, cx| {
                            this.filter = index as u8;
                            if index == 0 {
                                this.role_filter = None;
                            }
                            this.form = None;
                            cx.notify();
                        },
                        cx,
                    )
                    .justify_start()
                }),
            )
            .child(Self::caption("Roles").mt_3())
            .children(roles.drain(..).map(|(role, count)| {
                let role_id = role.to_owned();
                let active = self.role_filter.as_deref() == Some(role);
                Self::action(
                    role,
                    format!("{}   {}", crate::model::role_label(role), count),
                    active,
                    move |this, _, cx| {
                        this.role_filter = if this.role_filter.as_deref() == Some(&role_id) {
                            None
                        } else {
                            Some(role_id.clone())
                        };
                        this.form = None;
                        cx.notify();
                    },
                    cx,
                )
                .justify_start()
            }))
            .child(div().flex_1())
            .child(Self::caption("Local inference"))
            .child(div().text_size(px(14.)).mt_1().child(
                if self.lemonade.as_ref().is_some_and(|s| s.reachable) {
                    "Lemonade available"
                } else {
                    "Lemonade offline"
                },
            ))
            .child(Self::caption(
                self.lemonade
                    .as_ref()
                    .map(|s| {
                        if !s.loaded_models.is_empty() {
                            s.loaded_models.join(", ")
                        } else if s.reachable {
                            format!("No model loaded; {} available", s.available_models.len())
                        } else {
                            s.error
                                .clone()
                                .unwrap_or_else(|| "No local server detected".into())
                        }
                    })
                    .unwrap_or_else(|| "Checking local server…".into()),
            ))
            .child(div().h(px(1.)).bg(color(LINE)).my_4())
            .child(Self::caption("GPUI desktop"))
            .child(Self::caption("v0.1.0"))
    }
    fn agent_row(&self, agent: &Agent, index: usize, cx: &Context<Self>) -> Stateful<Div> {
        let selected = self.selected.as_ref() == Some(&agent.job_id);
        let id = agent.job_id.clone();
        let key_id = id.clone();
        let branch = agent
            .git
            .as_ref()
            .map(|g| g.branch.as_str())
            .unwrap_or("Worktree unknown");
        div()
            .id(("agent", index))
            .tab_index(0)
            .w_full()
            .p_4()
            .flex()
            .flex_col()
            .gap_2()
            .cursor_pointer()
            .border_b_1()
            .border_l_2()
            .border_color(color(if selected { ACCENT } else { LINE }))
            .bg(color(if selected { RAISED } else { BACKGROUND }))
            .hover(|s| s.bg(color(RAISED)))
            .focus(|s| s.border_color(color(ACCENT)))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.selected = Some(id.clone());
                this.confirm = None;
                this.form = None;
                cx.notify();
            }))
            .on_key_down(cx.listener(move |this, e: &KeyDownEvent, _, cx| {
                if e.keystroke.key == "enter" {
                    this.selected = Some(key_id.clone());
                    this.form = None;
                    cx.notify();
                }
            }))
            .child(
                div()
                    .flex()
                    .justify_between()
                    .gap_2()
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_size(px(15.))
                            .child(agent.title().to_owned()),
                    )
                    .child(Self::caption(format!("PID {}", agent.root_pid))),
            )
            .child(Self::caption(branch.to_owned()).truncate())
            .child(
                div()
                    .flex()
                    .justify_between()
                    .text_size(px(12.))
                    .child(
                        div()
                            .text_color(color(if agent.managed() { ACCENT } else { MUTED }))
                            .child(if agent.managed() {
                                "Managed"
                            } else {
                                "Discovered"
                            }),
                    )
                    .child(format!(
                        "{:.1}% CPU   {:.0} MiB",
                        agent.total_cpu_percent, agent.total_memory_mb
                    )),
            )
    }
    fn list(&self, cx: &Context<Self>) -> Div {
        let query = self.search.read(cx).content.as_ref();
        let agents = filtered_agents(
            &self.agents,
            query,
            self.filter,
            self.role_filter.as_deref(),
        );
        div()
            .w(px(340.))
            .flex_shrink_0()
            .h_full()
            .flex()
            .flex_col()
            .border_r_1()
            .border_color(color(LINE))
            .child(
                div()
                    .p_4()
                    .border_b_1()
                    .border_color(color(LINE))
                    .child(self.search.clone()),
            )
            .child(
                div()
                    .id("agent-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .children(
                        agents
                            .iter()
                            .enumerate()
                            .map(|(i, agent)| self.agent_row(agent, i, cx)),
                    )
                    .when(agents.is_empty(), |s| {
                        s.child(div().p_5().text_color(color(MUTED)).child(
                            if self.last_success.is_none() {
                                "Connecting to the manager…"
                            } else if self.agents.is_empty() {
                                "No active agents. Launch one to begin."
                            } else {
                                "No matching agents."
                            },
                        ))
                    }),
            )
    }
    fn details(&self, agent: &Agent, cx: &Context<Self>) -> Stateful<Div> {
        let selected = agent.clone();
        let root_command = agent
            .processes
            .iter()
            .find(|p| p.pid == agent.root_pid)
            .map(|p| p.cmdline.clone())
            .unwrap_or_else(|| "Root process has exited".into());
        let repo = agent
            .git
            .as_ref()
            .map(|g| g.repo_root.clone())
            .unwrap_or_else(|| "Not observable for this process".into());
        let branch = agent
            .git
            .as_ref()
            .map(|g| {
                format!(
                    "{}{}",
                    g.branch,
                    if g.is_worktree {
                        " (linked worktree)"
                    } else {
                        ""
                    }
                )
            })
            .unwrap_or_else(|| "Unknown".into());
        div()
            .id("details")
            .flex_1()
            .min_w_0()
            .h_full()
            .overflow_y_scroll()
            .child(
                div()
                    .p_6()
                    .flex()
                    .flex_col()
                    .gap_5()
                    .child(
                        div()
                            .flex()
                            .justify_between()
                            .items_center()
                            .gap_3()
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap_1()
                                    .child(Self::caption("Selected agent"))
                                    .child(
                                        div()
                                            .text_size(px(26.))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child(agent.title().to_owned()),
                                    ),
                            )
                            .child(
                                Self::action(
                                    "stop",
                                    if self.busy { "Working…" } else { "Stop tree" },
                                    false,
                                    move |this, _, cx| {
                                        if let Some(agent) =
                                            request_stop(this.connected(), this.busy, &selected)
                                        {
                                            this.confirm = Some(agent);
                                            cx.notify();
                                        }
                                    },
                                    cx,
                                )
                                .text_color(color(DANGER))
                                .when(self.busy || !self.connected(), |s| s.opacity(0.4)),
                            ),
                    )
                    .when(
                        self.confirm
                            .as_ref()
                            .is_some_and(|a| a.identity() == agent.identity()),
                        |s| {
                            let pending = self.confirm.as_ref().unwrap().clone();
                            s.child(
                        div()
                            .p_4()
                            .border_1()
                            .border_color(color(DANGER))
                            .rounded_md()
                            .flex()
                            .flex_col()
                            .gap_3()
                            .child(format!(
                                "Stop this agent and its {} observed processes?",
                                pending.processes.len()
                            ))
                            .child(Self::caption(if pending.managed() {
                                "Running work in this tree will be interrupted."
                            } else {
                                "This tree was discovered passively. Termination is best effort."
                            }))
                            .child(
                                div()
                                    .flex()
                                    .gap_2()
                                    .child(
                                        Self::action(
                                            "confirm-stop",
                                            "Stop now",
                                            false,
                                            move |this, _, cx| {
                                                if this.busy || !this.connected() {
                                                    return;
                                                }
                                                let (id, start_time) = pending.identity();
                                                this.busy = true;
                                                this.send(Command::Stop { id, start_time });
                                                cx.notify();
                                            },
                                            cx,
                                        )
                                        .text_color(color(DANGER)),
                                    )
                                    .child(Self::action(
                                        "cancel-stop",
                                        "Keep running",
                                        false,
                                        |this, _, cx| {
                                            this.confirm = None;
                                            cx.notify();
                                        },
                                        cx,
                                    )),
                            ),
                    )
                        },
                    )
                    .child(
                        Self::caption(agent.job_id.clone())
                            .font_family(MONO)
                            .truncate(),
                    )
                    .child(
                        div()
                            .flex()
                            .gap_8()
                            .py_4()
                            .border_y_1()
                            .border_color(color(LINE))
                            .child(
                                div().child(Self::caption("CPU / one core")).child(
                                    div()
                                        .text_size(px(30.))
                                        .child(format!("{:.1}%", agent.total_cpu_percent)),
                                ),
                            )
                            .child(
                                div().child(Self::caption("Memory")).child(
                                    div()
                                        .text_size(px(30.))
                                        .child(format!("{:.0} MiB", agent.total_memory_mb)),
                                ),
                            )
                            .child(
                                div().child(Self::caption("Processes")).child(
                                    div()
                                        .text_size(px(30.))
                                        .child(agent.processes.len().to_string()),
                                ),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .gap_6()
                            .py_2()
                            .child(Self::fact(
                                "GPU",
                                agent
                                    .gpu_percent
                                    .map(|v| format!("{v:.1}%"))
                                    .unwrap_or_default(),
                            ))
                            .child(Self::fact(
                                "NPU",
                                agent
                                    .npu_percent
                                    .map(|v| format!("{v:.1}%"))
                                    .unwrap_or_default(),
                            ))
                            .child(Self::fact(
                                "GPU memory",
                                agent
                                    .gpu_memory_mb
                                    .map(|v| format!("{v:.1} MiB"))
                                    .unwrap_or_default(),
                            )),
                    )
                    .child(Self::caption({
                        let devices = agent
                            .processes
                            .iter()
                            .flat_map(|process| &process.accelerators)
                            .map(|usage| format!("{} {}", usage.kind, usage.device_id))
                            .collect::<std::collections::BTreeSet<_>>()
                            .into_iter()
                            .collect::<Vec<_>>();
                        let device_line = if devices.is_empty() {
                            "Devices: none observed".to_owned()
                        } else {
                            format!("Devices: {}", devices.join(", "))
                        };
                        let status =
                            match (agent.gpu_percent.is_some(), agent.npu_percent.is_some()) {
                                (true, true) => "GPU/NPU status: measured".to_owned(),
                                (true, false) => {
                                    "GPU status: measured · NPU: no measurement".to_owned()
                                }
                                (false, true) => {
                                    "GPU: no measurement · NPU status: measured".to_owned()
                                }
                                (false, false) => {
                                    "GPU/NPU status: no measurements available".to_owned()
                                }
                            };
                        format!("{device_line}  |  {status}")
                    }))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_4()
                            .child(Self::fact("Repository", repo))
                            .child(
                                div()
                                    .flex()
                                    .gap_8()
                                    .child(Self::fact("Branch", branch))
                                    .child(Self::fact("Peer", agent.user_or_peer.clone())),
                            )
                            .child(Self::fact("Containment", agent.containment_mode.clone()))
                            .child(Self::fact("Roles", agent.role_summary()))
                            .child(Self::fact("Backend", agent.backend.clone()))
                            .child(Self::caption(agent.backend_evidence.clone()))
                            .child(Self::fact("Root command", root_command).font_family(MONO)),
                    )
                    .child(
                        div()
                            .mt_2()
                            .text_size(px(16.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Process tree"),
                    )
                    .child(
                        div()
                            .flex()
                            .px_3()
                            .text_size(px(12.))
                            .text_color(color(MUTED))
                            .child(div().flex_1().child("Process"))
                            .child(div().w(px(120.)).child("Role"))
                            .child(div().w(px(64.)).child("PID"))
                            .child(div().w(px(64.)).child("CPU"))
                            .child(div().w(px(84.)).child("Memory"))
                            .child(div().w(px(64.)).child("GPU"))
                            .child(div().w(px(64.)).child("NPU")),
                    )
                    .child(
                        div().flex().flex_col().children(
                            agent.process_rows().into_iter().enumerate().map(
                                |(index, (depth, p))| {
                                    let evidence = p.role_evidence.clone();
                                    let role_color = match p.role.as_str() {
                                        "agent" | "subagent" => ACCENT,
                                        "shell" | "tool" => MUTED,
                                        _ => TEXT,
                                    };
                                    div()
                                        .id(("process", index))
                                        .flex()
                                        .gap_2()
                                        .items_center()
                                        .py_3()
                                        .px_3()
                                        .border_b_1()
                                        .border_color(color(LINE))
                                        .text_size(px(12.))
                                        .font_family(MONO)
                                        .child(
                                            div()
                                                .flex_1()
                                                .min_w_0()
                                                .pl(px(depth as f32 * 14.))
                                                .truncate()
                                                .child(format!(
                                                    "{}{}",
                                                    if depth > 0 { "└ " } else { "" },
                                                    p.name
                                                )),
                                        )
                                        .child(
                                            div()
                                                .id(("role", p.pid))
                                                .w(px(120.))
                                                .text_color(color(role_color))
                                                .when(!evidence.is_empty(), |this| {
                                                    this.tooltip(move |_, cx| {
                                                        cx.new(|_| {
                                                            RoleTooltip(evidence.clone().into())
                                                        })
                                                        .into()
                                                    })
                                                })
                                                .child(p.role.clone()),
                                        )
                                        .child(div().w(px(64.)).child(p.pid.to_string()))
                                        .child(
                                            div()
                                                .w(px(64.))
                                                .child(format!("{:.1}%", p.cpu_percent)),
                                        )
                                        .child(
                                            div()
                                                .w(px(84.))
                                                .child(format!("{:.0} MiB", p.memory_mb)),
                                        )
                                        .child(div().w(px(64.)).child(format_accel(p, "gpu")))
                                        .child(div().w(px(64.)).child(format_accel(p, "npu")))
                                },
                            ),
                        ),
                    ),
            )
    }
    fn launch_form(&self, form: &LaunchForm, cx: &Context<Self>) -> Stateful<Div> {
        div().id("launch-form").flex_1().min_w_0().h_full().overflow_y_scroll().p_6().flex().flex_col().gap_5()
            .child(div().text_size(px(26.)).font_weight(FontWeight::SEMIBOLD).child("Launch an agent"))
            .child(Self::caption("Start a harness with process-tree containment."))
            .child({
                let query = form.harness_search.read(cx).content.as_ref();
                let choices = matching_harnesses(&self.harnesses, query);
                let count = choices.len();
                let selected = self.harnesses.iter().find(|h| h.id == form.harness).map(|h| h.label.clone()).unwrap_or_else(|| form.harness.clone());
                div().flex().flex_col().gap_2().child(Self::caption("Harness"))
                    .child(form.harness_search.clone())
                    .child(Self::caption(format!("{count} matching harnesses · selected: {selected}")))
                    .child(div().flex().flex_wrap().gap_2().children(choices.into_iter().enumerate().map(|(i, harness)| {
                        let id = harness.id.clone();
                        let selected_harness = form.harness == id;
                        Self::action(("harness", i), harness.label, selected_harness, move |this, _, cx| {
                            if let Some(form) = this.form.as_mut() { form.harness = id.clone(); cx.notify(); }
                        }, cx)
                    })))
            })
            .child(div().flex().flex_col().gap_2().child(Self::caption("Executable")).child(form.command.clone()))
            .child(div().flex().flex_col().gap_2().child(Self::caption("Arguments (JSON array)")).child(form.args.clone())
                .child(Self::caption(if cfg!(windows) { "For a Windows shim: cmd.exe with [\"/c\", \"codex.cmd\"]" } else { "For example: [\"--model\", \"my-model\"]" })))
            .child(div().flex().flex_col().gap_2().child(Self::caption("Working directory")).child(form.cwd.clone()))
            .child(Self::action("lemonade-toggle", if form.lemonade { "Use local Lemonade: on" } else { "Use local Lemonade: off" }, form.lemonade, |this, _, cx| { if let Some(form) = this.form.as_mut() { form.lemonade = !form.lemonade; cx.notify(); } }, cx).justify_start())
            .child(Self::caption("Jobs run in the background with output discarded. When opened with agtop ui, closing the window stops jobs launched here."))
            .child(div().flex().gap_2()
                .child(Self::action("launch", if self.busy { "Launching…" } else { "Launch agent" }, true, |this, _, cx| this.launch(cx), cx).when(self.busy || !self.connected(), |s| s.opacity(0.4)))
                .child(Self::action("cancel-launch", "Cancel", false, |this, window, cx| { if !this.busy { this.form = None; window.focus(&this.focus); cx.notify(); } }, cx)))
    }
}

fn fallback_harnesses() -> Vec<Harness> {
    [
        ("custom", "Custom command", "custom"),
        ("codex", "OpenAI Codex", "agent"),
        ("claude-code", "Claude Code", "agent"),
        ("opencode", "OpenCode", "agent"),
        ("gemini-cli", "Gemini CLI", "agent"),
        ("aider", "Aider", "agent"),
        ("goose", "Block Goose", "agent"),
        ("ollama", "Ollama", "server"),
    ]
    .into_iter()
    .map(|(id, label, kind)| Harness {
        id: id.into(),
        label: label.into(),
        kind: kind.into(),
    })
    .collect()
}

fn filtered_agents<'a>(
    agents: &'a [Agent],
    query: &str,
    filter: u8,
    role: Option<&str>,
) -> Vec<&'a Agent> {
    agents
        .iter()
        .filter(|agent| {
            agent.matches(query)
                && (filter == 0
                    || (filter == 1 && agent.managed())
                    || (filter == 2 && !agent.managed()))
                && role.map_or(true, |role| agent.has_role(role))
        })
        .collect()
}

fn keep_role_filter(agents: &[Agent], role: Option<&str>) -> bool {
    role.is_none_or(|role| agents.iter().any(|agent| agent.has_role(role)))
}

fn format_accel(process: &crate::model::Process, kind: &str) -> String {
    process
        .accelerators
        .iter()
        .find(|usage| usage.kind == kind)
        .and_then(|usage| usage.utilization_percent)
        .map(|value| format!("{value:.1}%"))
        .unwrap_or_default()
}

struct RoleTooltip(SharedString);

impl Render for RoleTooltip {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .p_2()
            .rounded_md()
            .bg(color(RAISED))
            .text_size(px(12.))
            .child(self.0.clone())
    }
}

// None means the selection still exists; Some(None) means the snapshot is empty.
fn refreshed_selection(agents: &[Agent], selected: Option<&str>) -> Option<Option<String>> {
    if selected.is_some_and(|id| agents.iter().any(|agent| agent.job_id == id)) {
        None
    } else {
        Some(agents.first().map(|agent| agent.job_id.clone()))
    }
}

fn matching_harnesses(harnesses: &[Harness], query: &str) -> Vec<Harness> {
    harnesses
        .iter()
        .filter(|harness| harness.matches(query))
        .cloned()
        .collect()
}

fn validate_launch_arguments(text: &str) -> Result<Vec<String>, String> {
    parse_arguments(text)
}

fn request_stop(connected: bool, busy: bool, agent: &Agent) -> Option<Agent> {
    (connected && !busy).then(|| agent.clone())
}

fn cancel_confirmation() -> Option<Agent> {
    None
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WorkbenchAction {
    NewAgent,
    Refresh,
    Quit,
}

fn shortcut_action(shortcut: &str) -> Option<WorkbenchAction> {
    match shortcut {
        NEW_AGENT_SHORTCUT => Some(WorkbenchAction::NewAgent),
        REFRESH_SHORTCUT => Some(WorkbenchAction::Refresh),
        QUIT_SHORTCUT => Some(WorkbenchAction::Quit),
        _ => None,
    }
}

impl Render for Workbench {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let total_memory: f64 = self.agents.iter().map(|a| a.total_memory_mb).sum();
        let total_processes: usize = self.agents.iter().map(|a| a.processes.len()).sum();
        let details = if let Some(form) = &self.form {
            self.launch_form(form, cx).into_any_element()
        } else if let Some(agent) = self
            .agents
            .iter()
            .find(|a| Some(&a.job_id) == self.selected.as_ref())
        {
            self.details(agent, cx).into_any_element()
        } else {
            div()
                .flex_1()
                .h_full()
                .p_8()
                .flex()
                .flex_col()
                .justify_center()
                .gap_3()
                .child(
                    div()
                        .text_size(px(28.))
                        .child("A clear view of your agents."),
                )
                .child(Self::caption(
                    "Select an agent to inspect its worktree, resources and child processes.",
                ))
                .child(Self::caption(
                    "Launch a managed agent to keep its process tree together.",
                ))
                .into_any_element()
        };
        div()
            .id("workbench")
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .bg(color(BACKGROUND))
            .text_color(color(TEXT))
            .font_family(FONT)
            .text_size(px(14.))
            .on_action(cx.listener(|_, _: &NextFocus, window, _| window.focus_next()))
            .on_action(cx.listener(|_, _: &PreviousFocus, window, _| window.focus_prev()))
            .on_action(cx.listener(|this, _: &Refresh, _, _| this.send(Command::Refresh)))
            .on_action(cx.listener(|this, _: &NewAgent, window, cx| this.open_form(window, cx)))
            .on_action(cx.listener(|this, _: &Dismiss, window, cx| {
                if !this.busy {
                    this.confirm = cancel_confirmation();
                    this.form = None;
                    window.focus(&this.focus);
                    cx.notify();
                }
            }))
            .child(self.navigation(cx))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .h(px(88.))
                            .flex_shrink_0()
                            .px_6()
                            .flex()
                            .items_center()
                            .justify_between()
                            .border_b_1()
                            .border_color(color(LINE))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap_1()
                                    .child(
                                        div()
                                            .text_size(px(22.))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child("Agent activity"),
                                    )
                                    .child(Self::caption(format!(
                                        "{} agents   {} processes   {:.0} MiB total",
                                        self.agents.len(),
                                        total_processes,
                                        total_memory
                                    ))),
                            )
                            .child(
                                div()
                                    .flex()
                                    .gap_2()
                                    .child(Self::action(
                                        "refresh",
                                        "Refresh",
                                        false,
                                        |this, _, _| this.send(Command::Refresh),
                                        cx,
                                    ))
                                    .child(Self::action(
                                        "new-agent",
                                        "New agent",
                                        true,
                                        |this, window, cx| this.open_form(window, cx),
                                        cx,
                                    )),
                            ),
                    )
                    .when(self.error.is_some() || self.notice.is_some(), |s| {
                        s.child(
                            div()
                                .px_5()
                                .py_3()
                                .bg(color(PANEL))
                                .border_b_1()
                                .border_color(color(LINE))
                                .flex()
                                .items_center()
                                .gap_4()
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .text_size(px(13.))
                                        .text_color(color(if self.error.is_some() {
                                            DANGER
                                        } else {
                                            ACCENT
                                        }))
                                        .child(
                                            self.error
                                                .clone()
                                                .or(self.notice.clone())
                                                .unwrap_or_default(),
                                        ),
                                )
                                .child(Self::action(
                                    "dismiss-notice",
                                    "Dismiss",
                                    false,
                                    |this, _, cx| {
                                        this.error = None;
                                        this.notice = None;
                                        cx.notify();
                                    },
                                    cx,
                                )),
                        )
                    })
                    .child(
                        div()
                            .flex_1()
                            .min_h_0()
                            .flex()
                            .child(self.list(cx))
                            .child(details),
                    )
                    .child(
                        div()
                            .h(px(34.))
                            .flex_shrink_0()
                            .border_t_1()
                            .border_color(color(LINE))
                            .px_5()
                            .flex()
                            .items_center()
                            .justify_between()
                            .text_size(px(11.))
                            .text_color(color(MUTED))
                            .child(if self.connected() {
                                "Connected to local manager  |  Updates every 2 seconds"
                            } else if self.last_success.is_some() {
                                "Connection stale  |  Showing the last successful snapshot"
                            } else {
                                "Connecting to local manager"
                            })
                            .child(if cfg!(target_os = "macos") {
                                "⌘N  New agent     ⌘R  Refresh"
                            } else {
                                "Ctrl+N  New agent     Ctrl+R  Refresh"
                            }),
                    ),
            )
    }
}

pub fn init(cx: &mut App) {
    crate::input::init(cx);
    cx.bind_keys([
        KeyBinding::new("tab", NextFocus, None),
        KeyBinding::new("shift-tab", PreviousFocus, None),
        KeyBinding::new(REFRESH_SHORTCUT, Refresh, None),
        KeyBinding::new(NEW_AGENT_SHORTCUT, NewAgent, None),
        KeyBinding::new(DISMISS_SHORTCUT, Dismiss, None),
        KeyBinding::new(QUIT_SHORTCUT, Quit, None),
    ]);
    cx.on_action(|_: &Quit, cx| cx.quit());
}

#[cfg(test)]
mod tests {
    use super::{
        NEW_AGENT_SHORTCUT, QUIT_SHORTCUT, REFRESH_SHORTCUT, WorkbenchAction, cancel_confirmation,
        fallback_harnesses, filtered_agents, format_accel, keep_role_filter, matching_harnesses,
        refreshed_selection, request_stop, shortcut_action, validate_launch_arguments,
    };
    use crate::model::{AcceleratorUsage, Agent, Process, ROLE_ORDER, role_label};

    fn agent(id: &str, harness: &str, branch: &str, pid: u32) -> Agent {
        Agent {
            job_id: id.into(),
            harness: harness.into(),
            root_pid: pid,
            containment_mode: "job-object".into(),
            git: Some(crate::model::GitInfo {
                branch: branch.into(),
                ..Default::default()
            }),
            processes: vec![crate::model::Process {
                pid,
                // Keep the process name aligned with the harness so search
                // tests do not accidentally match unrelated fixtures.
                name: harness.into(),
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    #[test]
    fn agent_list_filter_searches_harness_branch_and_pid() {
        let agents = vec![
            agent("job-1", "codex", "feature/ui", 4101),
            agent("job-2", "claude", "main", 5202),
        ];
        assert_eq!(filtered_agents(&agents, "codex", 0, None).len(), 1);
        assert_eq!(
            filtered_agents(&agents, "FEATURE/UI", 0, None)[0].job_id,
            "job-1"
        );
        assert_eq!(filtered_agents(&agents, "5202", 0, None)[0].job_id, "job-2");
        assert!(filtered_agents(&agents, "missing", 0, None).is_empty());
    }

    #[test]
    fn accelerator_columns_are_blank_when_unmeasured() {
        let process = Process::default();
        assert_eq!(format_accel(&process, "gpu"), "");
        let process = Process {
            accelerators: vec![AcceleratorUsage {
                kind: "gpu".into(),
                utilization_percent: Some(12.5),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert_eq!(format_accel(&process, "gpu"), "12.5%");
        assert_eq!(format_accel(&process, "npu"), "");
    }

    #[test]
    fn role_filter_keeps_agents_with_the_selected_role() {
        let mut first = agent("job-1", "codex", "main", 100);
        first.role_counts.insert("agent".into(), 1);
        first.role_counts.insert("dev-server".into(), 2);
        let mut second = agent("job-2", "claude", "main", 200);
        second.role_counts.insert("agent".into(), 1);
        let agents = vec![first, second];
        assert_eq!(filtered_agents(&agents, "", 0, Some("dev-server")).len(), 1);
        assert_eq!(
            filtered_agents(&agents, "", 0, Some("dev-server"))[0].job_id,
            "job-1"
        );
    }

    #[test]
    fn role_filter_is_cleared_when_snapshot_loses_the_role() {
        let mut value = agent("job-1", "codex", "main", 100);
        value.role_counts.insert("test-runner".into(), 1);
        assert!(keep_role_filter(
            std::slice::from_ref(&value),
            Some("test-runner")
        ));
        value.role_counts.clear();
        assert!(!keep_role_filter(&[value], Some("test-runner")));
        assert!(keep_role_filter(&[], None));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_shortcuts_use_ctrl() {
        assert_eq!(NEW_AGENT_SHORTCUT, "ctrl-n");
        assert_eq!(REFRESH_SHORTCUT, "ctrl-r");
        assert_eq!(QUIT_SHORTCUT, "ctrl-q");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_shortcuts_use_cmd() {
        assert_eq!(NEW_AGENT_SHORTCUT, "cmd-n");
        assert_eq!(REFRESH_SHORTCUT, "cmd-r");
        assert_eq!(QUIT_SHORTCUT, "cmd-q");
    }

    #[test]
    fn role_summary_and_role_search_follow_role_catalog() {
        let mut value = agent("job", "codex", "main", 100);
        value.role_counts.insert("tool".into(), 4);
        value.role_counts.insert("agent".into(), 1);
        value.role_counts.insert("dev-server".into(), 2);
        assert_eq!(value.role_summary(), "agent 1, dev-server 2, tool 4");
        assert_eq!(ROLE_ORDER.len(), 13);
        assert_eq!(role_label("dev-server"), "Dev server");
        assert!(value.matches("dev-server"));
    }

    #[test]
    fn selected_agent_survives_snapshot_refresh() {
        let agents = vec![
            agent("job-1", "codex", "main", 100),
            agent("job-2", "claude", "main", 200),
        ];
        assert_eq!(refreshed_selection(&agents, Some("job-2")), None);
        assert_eq!(
            refreshed_selection(&agents, Some("removed")),
            Some(Some("job-1".into()))
        );
        assert_eq!(refreshed_selection(&[], Some("removed")), Some(None));
    }

    #[test]
    fn harness_picker_search_matches_id_label_and_kind() {
        let choices = fallback_harnesses();
        assert_eq!(matching_harnesses(&choices, "CLAUDE")[0].id, "claude-code");
        assert_eq!(matching_harnesses(&choices, "server").len(), 1);
        assert!(matching_harnesses(&choices, "no such harness").is_empty());
    }

    #[test]
    fn launch_arguments_report_json_array_validation_errors() {
        assert_eq!(
            validate_launch_arguments(r#"["--model", "small"]"#).unwrap(),
            vec!["--model", "small"]
        );
        assert_eq!(
            validate_launch_arguments("--model small").unwrap_err(),
            "Arguments must be a JSON array of strings, for example [\"--model\", \"my-model\"]."
        );
        assert!(validate_launch_arguments("[1]").is_err());
    }

    #[test]
    fn stop_waits_for_confirmation_and_escape_cancels_it() {
        let selected = agent("job-1", "codex", "main", 100);
        assert!(request_stop(false, false, &selected).is_none());
        assert!(request_stop(true, true, &selected).is_none());
        let pending =
            request_stop(true, false, &selected).expect("confirmation should be requested");
        assert_eq!(pending.identity(), selected.identity());
        assert!(cancel_confirmation().is_none());
    }

    #[test]
    fn platform_shortcuts_map_to_actions() {
        assert_eq!(
            shortcut_action(NEW_AGENT_SHORTCUT),
            Some(WorkbenchAction::NewAgent)
        );
        assert_eq!(
            shortcut_action(REFRESH_SHORTCUT),
            Some(WorkbenchAction::Refresh)
        );
        assert_eq!(shortcut_action(QUIT_SHORTCUT), Some(WorkbenchAction::Quit));
    }
}
