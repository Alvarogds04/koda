use super::super::mcp::*;
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Never(AtomicUsize);
impl Desktop for Never {
    fn pick_target(&self) -> Result<Target, CaptureError> { self.0.fetch_add(1, Ordering::SeqCst); Err(CaptureError::NoWindow) }
    fn capture(&self, _: &Target) -> Result<Shot, CaptureError> { Err(CaptureError::NoWindow) }
}
struct Yes;
impl Dialogs for Yes { fn ask_grant(&self) -> bool { true } }

fn exchange(url: &str, request: &str) -> String {
    let address = url.trim_start_matches("http://").trim_end_matches("/mcp");
    let mut stream = TcpStream::connect(address).unwrap();
    stream.write_all(request.as_bytes()).unwrap();
    let mut reply = String::new();
    stream.read_to_string(&mut reply).unwrap();
    reply
}

#[test]
fn the_loopback_server_checks_the_token_and_answers_json() {
    let token = new_token();
    let helper = Helper::new(Arc::new(Never(AtomicUsize::new(0))), Arc::new(Yes), Arc::new(|| 0), Arc::new(|| true), token.clone());
    let endpoint = start(Arc::new(helper)).unwrap();
    assert!(endpoint.url.starts_with("http://127.0.0.1:") && endpoint.url.ends_with("/mcp"));
    let body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;
    let request = |auth: &str| format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n{auth}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let denied = exchange(&endpoint.url, &request(""));
    assert!(denied.starts_with("HTTP/1.1 401"), "{denied}");
    assert!(!denied.to_ascii_lowercase().contains("access-control"), "{denied}");
    let allowed = exchange(&endpoint.url, &request(&format!("Authorization: Bearer {token}\r\n")));
    assert!(allowed.starts_with("HTTP/1.1 200"), "{allowed}");
    assert!(allowed.contains(TOOL), "{allowed}");
}

#[test]
fn an_oversized_body_is_refused() {
    let helper = Helper::new(Arc::new(Never(AtomicUsize::new(0))), Arc::new(Yes), Arc::new(|| 0), Arc::new(|| true), "t".into());
    let endpoint = start(Arc::new(helper)).unwrap();
    let reply = exchange(&endpoint.url, "POST /mcp HTTP/1.1\r\nAuthorization: Bearer t\r\nContent-Length: 99999999\r\nConnection: close\r\n\r\n");
    assert!(reply.starts_with("HTTP/1.1 400"), "{reply}");
}

// M3: a slow reader is cut off at its deadline, only a loopback peer is served.
#[test]
fn a_client_that_sends_half_a_request_and_stops_is_cut_off_at_the_deadline() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let addr = listener.local_addr().unwrap();
    let client = std::thread::spawn(move || {
        let mut s = TcpStream::connect(addr).unwrap();
        s.write_all(b"POST /mcp HTTP/1.1\r\nContent-Length: 10\r\n").unwrap(); // never finishes the head
        std::thread::sleep(Duration::from_millis(600));
    });
    let (mut stream, _) = listener.accept().unwrap();
    let started = Instant::now();
    assert!(read_request(&mut stream, Duration::from_millis(150)).is_none());
    assert!(started.elapsed() < Duration::from_millis(500), "{:?}", started.elapsed());
    client.join().unwrap();
}

#[test]
fn a_body_that_never_arrives_is_cut_off_at_the_deadline() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let addr = listener.local_addr().unwrap();
    let client = std::thread::spawn(move || {
        let mut s = TcpStream::connect(addr).unwrap();
        s.write_all(b"POST /mcp HTTP/1.1\r\nContent-Length: 50\r\n\r\n{").unwrap();
        std::thread::sleep(Duration::from_millis(600));
    });
    let (mut stream, _) = listener.accept().unwrap();
    assert!(read_request(&mut stream, Duration::from_millis(150)).is_none());
    client.join().unwrap();
}

#[test]
fn only_an_ipv4_loopback_peer_is_served() {
    use std::net::{SocketAddr, SocketAddrV4, SocketAddrV6, Ipv6Addr};
    assert!(is_loopback_peer(&SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(127, 0, 0, 1), 1))));
    assert!(is_loopback_peer(&SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(127, 9, 9, 9), 1))));
    assert!(!is_loopback_peer(&SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(192, 168, 1, 5), 1))));
    assert!(!is_loopback_peer(&SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 1))));
    assert!(!is_loopback_peer(&SocketAddr::V6(SocketAddrV6::new(Ipv6Addr::LOCALHOST, 1, 0, 0))));
}
