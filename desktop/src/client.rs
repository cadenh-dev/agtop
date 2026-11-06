use crate::model::{Agent, Harness, KillResult, Launch, Lemonade};
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
        if !response.status().is_success() {
            bail!("Daemon returned HTTP {}.", response.status());
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
    Stop { id: String, start_time: String },
    Launch(Launch),
}
pub enum Event {
    Snapshot(Vec<Agent>),
    Harnesses(Vec<Harness>),
    Lemonade(Lemonade),
    Error(String),
    Completed(String),
    Launched(String),
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
        loop {
            let command = if first {
                first = false;
                Ok(Command::Refresh)
            } else {
                commands.recv_timeout(Duration::from_secs(2))
            };
            let action: Result<Option<Event>> = match command {
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) | Ok(Command::Refresh) => Ok(None),
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
        }
    });
    (send_command, receive_event)
}

fn encode_segment(text: &str) -> String {
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
