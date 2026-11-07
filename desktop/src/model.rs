use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const ROLE_ORDER: &[&str] = &[
    "agent",
    "subagent",
    "mcp-server",
    "inference-server",
    "dev-server",
    "language-server",
    "test-runner",
    "build",
    "package-manager",
    "git",
    "browser",
    "shell",
    "tool",
];

pub fn role_label(role: &str) -> &str {
    match role {
        "agent" => "Agent",
        "subagent" => "Subagent",
        "mcp-server" => "MCP server",
        "inference-server" => "Inference server",
        "dev-server" => "Dev server",
        "language-server" => "Language server",
        "test-runner" => "Test runner",
        "build" => "Build",
        "package-manager" => "Package manager",
        "git" => "Version control",
        "browser" => "Browser",
        "shell" => "Shell",
        _ => "Tool",
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
    pub cmdline: String,
    pub start_time: String,
    pub cpu_percent: f64,
    pub memory_mb: f64,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub role_source: String,
    #[serde(default)]
    pub role_evidence: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub repo_root: String,
    pub branch: String,
    pub is_worktree: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub job_id: String,
    pub harness: String,
    pub backend: String,
    pub backend_evidence: String,
    pub user_or_peer: String,
    pub root_pid: u32,
    pub git: Option<GitInfo>,
    pub containment_mode: String,
    pub total_cpu_percent: f64,
    pub total_memory_mb: f64,
    pub processes: Vec<Process>,
    #[serde(default)]
    pub role_counts: BTreeMap<String, u32>,
}

impl Agent {
    pub fn role_summary(&self) -> String {
        ROLE_ORDER
            .iter()
            .filter_map(|role| {
                self.role_counts
                    .get(*role)
                    .filter(|count| **count > 0)
                    .map(|count| format!("{} {}", role, count))
            })
            .collect::<Vec<_>>()
            .join(", ")
    }
    pub fn has_role(&self, role: &str) -> bool {
        self.role_counts.get(role).is_some_and(|count| *count > 0)
    }
    pub fn managed(&self) -> bool {
        self.containment_mode != "passive-ppid"
    }
    pub fn title(&self) -> &str {
        &self.harness
    }
    pub fn matches(&self, query: &str) -> bool {
        let processes = self
            .processes
            .iter()
            .map(|p| format!("{} {} {}", p.name, p.cmdline, p.pid))
            .collect::<Vec<_>>()
            .join(" ");
        let text = format!(
            "{} {} {} {} {} {} {} {} {}",
            self.harness,
            self.job_id,
            self.root_pid,
            self.user_or_peer,
            self.backend,
            self.role_counts
                .keys()
                .map(|role| format!("{} {}", role, role_label(role)))
                .collect::<Vec<_>>()
                .join(" "),
            self.processes
                .iter()
                .map(|p| format!("{} {}", p.role, role_label(&p.role)))
                .collect::<Vec<_>>()
                .join(" "),
            self.git
                .as_ref()
                .map(|g| format!("{} {}", g.repo_root, g.branch))
                .unwrap_or_default(),
            processes
        );
        text.to_lowercase().contains(&query.to_lowercase())
    }
    pub fn identity(&self) -> (String, String) {
        (
            self.job_id.clone(),
            self.processes
                .iter()
                .find(|p| p.pid == self.root_pid)
                .map(|p| p.start_time.clone())
                .unwrap_or_default(),
        )
    }
    pub fn process_rows(&self) -> Vec<(usize, &Process)> {
        fn walk<'a>(
            pid: u32,
            depth: usize,
            processes: &'a [Process],
            seen: &mut std::collections::HashSet<u32>,
            out: &mut Vec<(usize, &'a Process)>,
        ) {
            if !seen.insert(pid) {
                return;
            }
            if let Some(p) = processes.iter().find(|p| p.pid == pid) {
                out.push((depth, p));
                for child in processes.iter().filter(|child| child.ppid == pid) {
                    walk(
                        child.pid,
                        depth.saturating_add(1).min(8),
                        processes,
                        seen,
                        out,
                    );
                }
            }
        }
        let mut rows = Vec::new();
        let mut seen = std::collections::HashSet::new();
        walk(self.root_pid, 0, &self.processes, &mut seen, &mut rows);
        for p in &self.processes {
            walk(p.pid, 0, &self.processes, &mut seen, &mut rows);
        }
        rows
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lemonade {
    pub reachable: bool,
    pub loaded_models: Vec<String>,
    pub available_models: Vec<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Harness {
    pub id: String,
    pub label: String,
    pub kind: String,
}

impl Harness {
    pub fn matches(&self, query: &str) -> bool {
        format!("{} {} {}", self.id, self.label, self.kind)
            .to_lowercase()
            .contains(&query.to_lowercase())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Launch {
    pub harness: String,
    pub command: String,
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub use_lemonade_local: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KillResult {
    pub killed_pids: Vec<u32>,
    pub failed_pids: Vec<u32>,
    pub errors: Vec<String>,
}

pub fn parse_arguments(text: &str) -> Result<Vec<String>, String> {
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str::<Vec<String>>(text).map_err(|_| {
        "Arguments must be a JSON array of strings, for example [\"--model\", \"my-model\"].".into()
    })
}

#[cfg(test)]
mod tests {
    use super::{Agent, GitInfo, Harness, Process, ROLE_ORDER, parse_arguments};
    #[test]
    fn arguments_preserve_paths_quotes_and_empty_values() {
        assert_eq!(
            parse_arguments(r#"["C:\\work tree", "", "a\"b"]"#).unwrap(),
            vec!["C:\\work tree", "", "a\"b"]
        );
        assert!(parse_arguments("--model foo").is_err());
        assert!(parse_arguments("[1]").is_err());
    }
    #[test]
    fn process_tree_handles_orphans_and_cycles() {
        let agent = Agent {
            root_pid: 10,
            processes: vec![
                Process {
                    pid: 30,
                    ppid: 20,
                    ..Default::default()
                },
                Process {
                    pid: 10,
                    ppid: 0,
                    ..Default::default()
                },
                Process {
                    pid: 20,
                    ppid: 10,
                    ..Default::default()
                },
                Process {
                    pid: 40,
                    ppid: 40,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        assert_eq!(
            agent
                .process_rows()
                .iter()
                .map(|(d, p)| (*d, p.pid))
                .collect::<Vec<_>>(),
            vec![(0, 10), (1, 20), (2, 30), (0, 40)]
        );
    }
    #[test]
    fn filter_includes_worktree_branch() {
        let agent = Agent {
            git: Some(GitInfo {
                branch: "feature/GPUI".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(agent.matches("gpui"));
        assert!(!agent.matches("unrelated"));
    }
    #[test]
    fn filter_includes_process_commands() {
        let agent = Agent {
            harness: "claude-code".into(),
            processes: vec![Process {
                name: "node".into(),
                cmdline: "claude --resume".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(agent.matches("claude --resume"));
        assert!(agent.matches("CLAUDE-CODE"));
        assert!(!agent.matches("ollama"));
    }
    #[test]
    fn harness_filter_matches_id_label_and_kind() {
        let harness = Harness {
            id: "claude-code".into(),
            label: "Claude Code".into(),
            kind: "agent".into(),
        };
        assert!(harness.matches("claude"));
        assert!(harness.matches("agent"));
        assert!(!harness.matches("server"));
    }

    #[test]
    fn roles_deserialize_and_legacy_payloads_default_roles() {
        let with_roles: Agent = serde_json::from_str(
            r#"{
            "jobId":"j","harness":"codex","backend":"unknown","backendEvidence":"",
            "userOrPeer":"p","rootPid":1,"containmentMode":"passive-ppid",
            "totalCpuPercent":0,"totalMemoryMb":0,"processes":[{"pid":1,"ppid":0,"name":"codex",
            "cmdline":"codex","startTime":"1","cpuPercent":0,"memoryMb":0,"role":"agent",
            "roleSource":"job","roleEvidence":"root of job j"}],"roleCounts":{"agent":1}
        }"#,
        )
        .unwrap();
        assert_eq!(with_roles.processes[0].role, "agent");
        assert_eq!(with_roles.processes[0].role_source, "job");
        assert_eq!(with_roles.role_summary(), "agent 1");
        assert!(with_roles.has_role("agent"));

        let legacy: Agent = serde_json::from_str(
            r#"{
            "jobId":"j","harness":"codex","backend":"unknown","backendEvidence":"",
            "userOrPeer":"p","rootPid":1,"containmentMode":"passive-ppid",
            "totalCpuPercent":0,"totalMemoryMb":0,"processes":[{"pid":1,"ppid":0,"name":"codex",
            "cmdline":"codex","startTime":"1","cpuPercent":0,"memoryMb":0}]
        }"#,
        )
        .unwrap();
        assert!(legacy.role_counts.is_empty());
        assert_eq!(legacy.processes[0].role, "");
        assert_eq!(ROLE_ORDER.len(), 13);
    }

    #[test]
    fn role_summary_uses_role_order_and_omits_zero_counts() {
        let mut agent = Agent::default();
        agent.role_counts.insert("tool".into(), 2);
        agent.role_counts.insert("agent".into(), 1);
        agent.role_counts.insert("shell".into(), 0);
        assert_eq!(agent.role_summary(), "agent 1, tool 2");
        assert!(agent.matches("dev-server") == false);
        agent.role_counts.insert("dev-server".into(), 1);
        assert!(agent.matches("dev-server"));
        assert!(agent.matches("Dev server"));
    }
}
