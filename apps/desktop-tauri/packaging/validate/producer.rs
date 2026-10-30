//! Probe-only Pi fixture. Like a real adapter it renews the receiver's 30 s
//! lease while the UI driver waits for animations, IPC, screenshots and input.
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

pub struct Producer {
    writer: Arc<Mutex<UnixStream>>,
    stop: mpsc::Sender<()>,
    worker: Option<JoinHandle<()>>,
    project: String,
}
impl Producer {
    pub fn start(stream: UnixStream, project: String) -> Self {
        let writer = Arc::new(Mutex::new(stream));
        let (stop, receive) = mpsc::channel();
        let heartbeat_writer = writer.clone();
        let heartbeat_project = project.clone();
        let worker = std::thread::spawn(move || {
            while matches!(receive.recv_timeout(Duration::from_secs(2)), Err(mpsc::RecvTimeoutError::Timeout)) {
                let frame = Self::frame(&heartbeat_project, serde_json::json!({"type":"heartbeat"}));
                // Serialize whole frames with main-thread fixture writes.
                if writeln!(heartbeat_writer.lock().expect("fixture writer"), "{frame}").is_err() { break; }
            }
        });
        Self { writer, stop, worker: Some(worker), project }
    }
    fn frame(project: &str, mut frame: serde_json::Value) -> serde_json::Value {
        frame["v"] = serde_json::json!(1);
        frame["project"] = serde_json::json!(project);
        frame["sessionId"] = serde_json::json!("validator-pi");
        frame["at"] = serde_json::json!(crate::now_ms() as u64);
        frame
    }
    pub fn send(&self, frame: serde_json::Value) -> Result<(), String> {
        let frame = Self::frame(&self.project, frame);
        writeln!(self.writer.lock().expect("fixture writer"), "{frame}").map_err(|e|e.to_string())
    }
}
impl Drop for Producer {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(worker) = self.worker.take() { let _ = worker.join(); }
        // No surviving heartbeat thread or live fixture after this scene group.
        if let Ok(writer) = self.writer.lock() { let _ = writer.shutdown(std::net::Shutdown::Both); }
    }
}
