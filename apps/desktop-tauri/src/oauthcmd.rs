//! Closed subscription command boundary. Authorization material is never Debug output.
use serde_json::{json, Value};
use std::sync::Mutex;
use crate::provider_oauth::{OAuth, Pending, Provider, Status};
#[derive(Clone, Copy)]
enum Action { Begin, Poll, Complete, Status, SignOut, Cancel }
pub struct Cmd { provider: Provider, action: Action, input: Option<String> }
impl std::fmt::Debug for Cmd { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("Cmd(<redacted>)") } }
pub fn parse(value: &Value) -> Option<Cmd> {
    let obj = value.as_object()?;
    let provider = match obj.get("provider")?.as_str()? { "claude" => Provider::Claude, "chatgpt" => Provider::Chatgpt, _ => return None };
    let action = match obj.get("action")?.as_str()? { "begin" => Action::Begin, "poll" => Action::Poll, "complete" => Action::Complete, "status" => Action::Status, "sign_out" => Action::SignOut, "cancel" => Action::Cancel, _ => return None };
    let complete = matches!(action, Action::Complete);
    if obj.len() != if complete { 3 } else { 2 } { return None; }
    let input = if complete {
        let s = obj.get("input")?.as_str()?;
        if s.is_empty() || s.len() > 2048 || s.chars().any(char::is_control) { return None; }
        Some(s.to_owned())
    } else { None };
    Some(Cmd { provider, action, input })
}
/// Fixed slots: replacing a flow drops its listener BEFORE attempting to bind again.
#[derive(Default)]
pub struct Flows { pending: Mutex<[Option<Pending>; 2]> }
impl std::fmt::Debug for Flows { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("Flows(<redacted>)") } }
impl Flows {
    pub fn apply(&self, oauth: &OAuth<'_>, cmd: Cmd, opener: &dyn Fn(&str) -> bool) -> Result<Value, &'static str> {
        let p = cmd.provider;
        let (i, provider) = match p { Provider::Claude => (0, "claude"), Provider::Chatgpt => (1, "chatgpt") };
        let mut slots = self.pending.lock().map_err(|_| "unavailable")?;
        let slot = &mut slots[i];
        let error = |e: crate::provider_oauth::OauthError| json!({"state":"error", "message":e.to_string()});
        Ok(match cmd.action {
            Action::Begin => {
                slot.take();
                let begun = oauth.begin(p).map_err(|_| "begin_failed")?;
                let opened = opener(&begun.auth_url);
                if !opened && p == Provider::Chatgpt { return Err("opener_unavailable"); }
                *slot = Some(begun.pending);
                if !opened { json!({"provider":provider,"state":"waiting","manual":true,"browserOpened":false,"authUrl":begun.auth_url}) }
                else { json!({"provider":provider,"state":"waiting","manual":p == Provider::Claude,"browserOpened":true}) }
            }
            Action::Poll => {
                if p == Provider::Claude { json!({"state":if slot.is_some() { "waiting" } else { "none" }}) }
                else if let Some(pending) = slot.as_mut() {
                    match oauth.complete_loopback(pending) {
                        Ok(false) => json!({"state":"waiting"}),
                        Ok(true) => { slot.take(); json!({"state":"done"}) },
                        Err(e) => { slot.take(); error(e) },
                    }
                } else { json!({"state":"none"}) }
            }
            Action::Complete => {
                if p != Provider::Claude { return Err("invalid_schema"); }
                if let Some(mut pending) = slot.take() {
                    match oauth.complete(&mut pending, cmd.input.as_deref().ok_or("invalid_schema")?) { Ok(()) => json!({"state":"done"}), Err(e) => error(e) }
                } else { json!({"state":"none"}) }
            }
            Action::Status => json!({"provider":provider,"state":match oauth.status(p).map_err(|_| "unavailable")? { Status::Present => "present", Status::Expired => "expired", Status::Absent => "absent" }}),
            Action::SignOut => { slot.take(); oauth.sign_out(p).map_err(|_| "unavailable")?; json!({"state":"absent"}) }
            Action::Cancel => { slot.take(); json!({"state":"none"}) }
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use crate::secrets::{SecretStore, StoreError};
    use crate::provider_oauth::{TokenHttp, TokenReply, OauthError};
    use std::collections::HashMap;
    #[derive(Default)]
    struct Memory(Mutex<HashMap<String,String>>);
    impl SecretStore for Memory {
        fn read(&self, k: &str) -> Result<Option<String>,StoreError> { Ok(self.0.lock().unwrap().get(k).cloned()) }
        fn write(&self, k: &str,v: &str) -> Result<(),StoreError> { self.0.lock().unwrap().insert(k.into(),v.into()); Ok(()) }
        fn delete(&self,k: &str) -> Result<(),StoreError> { self.0.lock().unwrap().remove(k); Ok(()) }
    }
    struct Fake;
    impl TokenHttp for Fake {
        fn post(&self, _: &str, _: &[(String,String)]) -> Result<TokenReply,OauthError> { Ok(TokenReply { status:200, body:br#"{"access_token":"access-secret","refresh_token":"refresh-secret","expires_in":3600,"token_type":"Bearer"}"#.to_vec() }) }
    }
    fn cmd(action: &str, provider: &str) -> Cmd { parse(&json!({"action":action,"provider":provider})).unwrap() }
    fn safe(v: &Value) { let text = v.to_string(); for secret in ["access-secret","refresh-secret","code-secret","code_verifier","code_challenge","authUrl"] { assert!(!text.contains(secret)); } }
    #[test]
    fn claude_flow_lifecycle_and_redaction() {
        let store = Memory::default(); let clock = || 100;
        let oauth = OAuth::new(&store,&Fake,&clock); let flows = Flows::default();
        assert_eq!(flows.apply(&oauth,cmd("status","claude"),&|_| true).unwrap()["state"],"absent");
        let seen = Mutex::new(String::new());
        let open = |url: &str| { *seen.lock().unwrap() = url.into(); true };
        let begun = flows.apply(&oauth,cmd("begin","claude"),&open).unwrap(); safe(&begun);
        let url = oauth2::url::Url::parse(&seen.lock().unwrap()).unwrap(); assert_eq!(url.host_str(),Some("claude.ai"));
        let state = url.query_pairs().find(|(k,_)| k == "state").unwrap().1.into_owned();
        assert!(!format!("{:?}", flows).contains(&state));
        assert_eq!(flows.apply(&oauth,cmd("poll","claude"),&open).unwrap()["state"],"waiting");
        let complete = parse(&json!({"action":"complete","provider":"claude","input":format!("code-secret#{state}")})).unwrap();
        assert!(!format!("{complete:?}").contains("code-secret"));
        let done = flows.apply(&oauth,complete,&open).unwrap(); safe(&done); assert_eq!(done["state"],"done");
        let status = flows.apply(&oauth,cmd("status","claude"),&open).unwrap(); safe(&status); assert_eq!(status["state"],"present");
        let late = || 4000; let expired = OAuth::new(&store,&Fake,&late);
        assert_eq!(flows.apply(&expired,cmd("status","claude"),&open).unwrap()["state"],"expired");
        safe(&flows.apply(&oauth,cmd("sign_out","claude"),&open).unwrap());
        assert_eq!(flows.apply(&oauth,cmd("status","claude"),&open).unwrap()["state"],"absent");
        let manual = flows.apply(&oauth,cmd("begin","claude"),&|u| { *seen.lock().unwrap() = u.into(); false }).unwrap();
        assert_eq!(manual["authUrl"],*seen.lock().unwrap()); assert_eq!(manual["browserOpened"],false);
        let old = seen.lock().unwrap().clone();
        flows.apply(&oauth,cmd("begin","claude"),&open).unwrap(); assert_ne!(*seen.lock().unwrap(),old);
        assert_eq!(flows.pending.lock().unwrap().iter().filter(|x| x.is_some()).count(),1);
        let error = flows.apply(&oauth,parse(&json!({"action":"complete","provider":"claude","input":"code-secret#wrong"})).unwrap(),&open).unwrap();
        safe(&error); assert_eq!(error["state"],"error");
        assert_eq!(flows.apply(&oauth,cmd("poll","claude"),&open).unwrap()["state"],"none");
        flows.apply(&oauth,cmd("begin","claude"),&open).unwrap(); safe(&flows.apply(&oauth,cmd("cancel","claude"),&open).unwrap());
        assert_eq!(flows.apply(&oauth,cmd("poll","claude"),&open).unwrap()["state"],"none");
    }
    #[test]
    fn chatgpt_opener_replacement_poll_and_cleanup() {
        use std::io::Write;
        let store = Memory::default(); let clock = std::sync::atomic::AtomicU64::new(100);
        let now = || clock.load(std::sync::atomic::Ordering::SeqCst);
        let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = reservation.local_addr().unwrap();
        let oauth = OAuth::new(&store,&Fake,&now).with_loopback(address); let flows = Flows::default();
        drop(reservation);
        assert_eq!(flows.apply(&oauth,cmd("begin","chatgpt"),&|_| {
            assert!(std::net::TcpListener::bind(address).is_err(), "begin must hold the configured port before opening");
            false
        }),Err("opener_unavailable"));
        assert!(std::net::TcpListener::bind(address).is_ok(), "failed opener must release the same port");
        let seen = Mutex::new(String::new());
        let open = |url: &str| { *seen.lock().unwrap() = url.into(); true };
        for _ in 0..2 { safe(&flows.apply(&oauth,cmd("begin","chatgpt"),&open).unwrap()); }
        let url = oauth2::url::Url::parse(&seen.lock().unwrap()).unwrap(); assert_eq!(url.host_str(),Some("auth.openai.com"));
        assert_eq!(flows.apply(&oauth,cmd("poll","chatgpt"),&open).unwrap()["state"],"waiting");
        let state = url.query_pairs().find(|(k,_)| k == "state").unwrap().1.into_owned();
        let mut browser = std::net::TcpStream::connect(address).unwrap();
        write!(browser,"GET /auth/callback?code=code-secret&state={state} HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
        let done = flows.apply(&oauth,cmd("poll","chatgpt"),&open).unwrap(); safe(&done); assert_eq!(done["state"],"done");
        flows.apply(&oauth,cmd("begin","chatgpt"),&open).unwrap(); clock.store(800,std::sync::atomic::Ordering::SeqCst);
        let expired = flows.apply(&oauth,cmd("poll","chatgpt"),&open).unwrap(); safe(&expired); assert_eq!(expired["state"],"error");
        for action in ["cancel","sign_out"] {
            flows.apply(&oauth,cmd("begin","chatgpt"),&open).unwrap(); safe(&flows.apply(&oauth,cmd(action,"chatgpt"),&open).unwrap());
            assert!(std::net::TcpListener::bind(address).is_ok());
        }
    }
    #[test]
    fn closed_schema() {
        for provider in ["claude", "chatgpt"] {
            for action in ["begin", "poll", "status", "sign_out", "cancel"] {
                assert!(parse(&json!({"action":action,"provider":provider})).is_some());
                assert!(parse(&json!({"action":action,"provider":provider,"input":"secret"})).is_none());
            }
            assert!(parse(&json!({"action":"complete","provider":provider,"input":"code#state"})).is_some());
            for input in ["".to_owned(), "x".repeat(2049), "é".repeat(1025), "x\ny".into(), "x\u{7f}".into(), "x\u{85}".into()] {
                assert!(parse(&json!({"action":"complete","provider":provider,"input":input})).is_none());
            }
        }
        for bad in [json!(null), json!([]), json!("begin"), json!({}), json!({"action":"begin"}), json!({"action":"begin","provider":"openai"}), json!({"action":"refresh","provider":"claude"}), json!({"action":"begin","provider":"claude","url":"https://evil.test"}), json!({"action":"complete","provider":"claude","input":5}), json!({"action":true,"provider":"claude"})] { assert!(parse(&bad).is_none()); }
    }
}
