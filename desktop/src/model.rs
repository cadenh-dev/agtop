use serde::{Deserialize, Serialize};

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
}

impl Agent {
    pub fn managed(&self) -> bool {
        self.containment_mode != "passive-ppid"
    }
    pub fn title(&self) -> &str {
        &self.harness
    }
    pub fn matches(&self, query: &str) -> bool {
        let text = format!(
            "{} {} {} {} {} {}",
            self.harness,
            self.job_id,
            self.root_pid,
            self.user_or_peer,
            self.backend,
            self.git
                .as_ref()
                .map(|g| format!("{} {}", g.repo_root, g.branch))
                .unwrap_or_default()
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
    use super::*;
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
}
