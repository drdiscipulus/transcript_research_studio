use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{
    env,
    io::{Read, Write},
    net::{IpAddr, TcpListener, TcpStream, ToSocketAddrs},
    time::Duration,
};

const DEFAULT_BACKEND_HOST: &str = "127.0.0.1";
const AUTH_HEADER_NAME: &str = "X-Transcript-Research-Studio-Token";
const HEALTH_RESPONSE_LIMIT: u64 = 64 * 1024;
const HEALTH_IO_TIMEOUT: Duration = Duration::from_millis(750);

#[derive(Clone)]
pub(crate) struct BackendConnection {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) auth_token: String,
}

impl BackendConnection {
    fn base_url(&self) -> String {
        let host = if self.host.contains(':') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        format!("http://{host}:{}", self.port)
    }
}

#[derive(Clone, Serialize)]
pub(crate) struct BackendClientConfig {
    base_url: String,
    auth_token: String,
}

pub(crate) struct BackendConnectionState(pub(crate) BackendConnection);

pub(super) fn backend_client_config(
    state: tauri::State<'_, BackendConnectionState>,
) -> BackendClientConfig {
    BackendClientConfig {
        base_url: state.0.base_url(),
        auth_token: state.0.auth_token.clone(),
    }
}

pub(crate) fn build_backend_connection() -> Result<BackendConnection, String> {
    let host = normalize_loopback_host(
        &env::var("TRANSCRIPT_RESEARCH_STUDIO_BACKEND_HOST")
            .unwrap_or_else(|_| DEFAULT_BACKEND_HOST.to_string()),
    )?;
    let port = match env::var("TRANSCRIPT_RESEARCH_STUDIO_BACKEND_PORT") {
        Ok(value) => parse_configured_port(&value)?,
        Err(env::VarError::NotPresent) => find_available_port(&host)?,
        Err(_) => return Err("The configured local service port is not valid Unicode.".to_string()),
    };
    let explicit_token = match env::var("TRANSCRIPT_RESEARCH_STUDIO_BACKEND_TOKEN") {
        Ok(value) => ExplicitToken::Value(value),
        Err(env::VarError::NotPresent) => ExplicitToken::Missing,
        Err(env::VarError::NotUnicode(_)) => ExplicitToken::NotUnicode,
    };
    let auth_token =
        select_auth_token(explicit_token, cfg!(debug_assertions), generate_auth_token)?;

    Ok(BackendConnection {
        host,
        port,
        auth_token,
    })
}

pub(crate) fn ensure_backend_port_available(connection: &BackendConnection) -> Result<(), String> {
    TcpListener::bind((connection.host.as_str(), connection.port))
        .map(drop)
        .map_err(|_| "The configured local service port is already in use.".to_string())
}

fn normalize_loopback_host(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    let host = match (value.strip_prefix('['), value.strip_suffix(']')) {
        (Some(without_open), Some(_)) => without_open
            .strip_suffix(']')
            .ok_or_else(|| "The local service host must be a loopback address.".to_string())?,
        (None, None) => value,
        _ => return Err("The local service host must be a loopback address.".to_string()),
    };
    if host.eq_ignore_ascii_case("localhost") {
        return Ok(DEFAULT_BACKEND_HOST.to_string());
    }
    let address = host
        .parse::<IpAddr>()
        .map_err(|_| "The local service host must be a loopback address.".to_string())?;
    if !address.is_loopback() {
        return Err("The local service host must be a loopback address.".to_string());
    }
    Ok(address.to_string())
}

fn parse_configured_port(raw: &str) -> Result<u16, String> {
    let port = raw.trim().parse::<u16>().map_err(|_| {
        "The configured local service port must be between 1 and 65535.".to_string()
    })?;
    if port == 0 {
        return Err("The configured local service port must be between 1 and 65535.".to_string());
    }
    Ok(port)
}

fn find_available_port(host: &str) -> Result<u16, String> {
    let listener = TcpListener::bind((host, 0))
        .map_err(|error| format!("Could not reserve a local service port: {error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("Could not read the reserved local service port: {error}"))
}

fn generate_auth_token() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

enum ExplicitToken {
    Missing,
    Value(String),
    NotUnicode,
}

fn select_auth_token(
    explicit: ExplicitToken,
    allow_development_override: bool,
    generate: impl FnOnce() -> String,
) -> Result<String, String> {
    if !allow_development_override {
        return Ok(generate());
    }
    match explicit {
        ExplicitToken::Missing => Ok(generate()),
        ExplicitToken::NotUnicode => {
            Err("The development authentication token is not valid Unicode.".to_string())
        }
        ExplicitToken::Value(value) => {
            if value.chars().any(char::is_control) {
                return Err(
                    "The development authentication token contains invalid characters.".to_string(),
                );
            }
            let trimmed = value.trim();
            if trimmed.is_empty() {
                Ok(generate())
            } else {
                Ok(trimmed.to_string())
            }
        }
    }
}

#[derive(Deserialize)]
struct HealthResponse {
    status: String,
    instance_id: String,
}

pub(crate) fn probe_authenticated_health(connection: &BackendConnection) -> Result<(), String> {
    let addresses = (connection.host.as_str(), connection.port)
        .to_socket_addrs()
        .map_err(|_| "The local service address could not be resolved.".to_string())?;
    let address = addresses
        .into_iter()
        .find(|address| address.ip().is_loopback())
        .ok_or_else(|| "The local service address is not loopback-only.".to_string())?;
    let mut stream =
        TcpStream::connect_timeout(&address, Duration::from_millis(250)).map_err(|_| {
            "The local service is not accepting authenticated health checks yet.".to_string()
        })?;
    stream
        .set_read_timeout(Some(HEALTH_IO_TIMEOUT))
        .map_err(|_| "Could not configure the health-check timeout.".to_string())?;
    stream
        .set_write_timeout(Some(HEALTH_IO_TIMEOUT))
        .map_err(|_| "Could not configure the health-check timeout.".to_string())?;

    let host_header = if connection.host.contains(':') {
        format!("[{}]:{}", connection.host, connection.port)
    } else {
        format!("{}:{}", connection.host, connection.port)
    };
    let request = format!(
        "GET /health HTTP/1.1\r\nHost: {host_header}\r\n{AUTH_HEADER_NAME}: {}\r\nConnection: close\r\n\r\n",
        connection.auth_token
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|_| "The authenticated health request could not be sent.".to_string())?;

    let mut response = Vec::new();
    stream
        .take(HEALTH_RESPONSE_LIMIT + 1)
        .read_to_end(&mut response)
        .map_err(|_| "The authenticated health response could not be read.".to_string())?;
    parse_health_response(&response)
}

fn parse_health_response(response: &[u8]) -> Result<(), String> {
    if response.len() as u64 > HEALTH_RESPONSE_LIMIT {
        return Err("The authenticated health response was too large.".to_string());
    }
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "The authenticated health response was malformed.".to_string())?;
    let headers = std::str::from_utf8(&response[..header_end])
        .map_err(|_| "The authenticated health response was malformed.".to_string())?;
    let status_line = headers.lines().next().unwrap_or_default();
    if !status_line.starts_with("HTTP/1.0 ") && !status_line.starts_with("HTTP/1.1 ") {
        return Err("The authenticated health response was malformed.".to_string());
    }
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "The authenticated health response was malformed.".to_string())?;
    if !(200..300).contains(&status) {
        return Err("The local service rejected the authenticated health check.".to_string());
    }
    let payload: HealthResponse = serde_json::from_slice(&response[header_end + 4..])
        .map_err(|_| "The authenticated health response was not valid JSON.".to_string())?;
    if payload.status != "ok" || payload.instance_id.trim().is_empty() {
        return Err("The local service returned an invalid health status.".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{net::Shutdown, thread};

    fn response(status: &str, body: &str) -> Vec<u8> {
        format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).into_bytes()
    }

    fn run_authenticated_probe(response: Vec<u8>) -> (Result<(), String>, bool) {
        let listener = TcpListener::bind((DEFAULT_BACKEND_HOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let token = "synthetic-request-token";
        let expected_header = format!("{AUTH_HEADER_NAME}: {token}\r\n");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 512];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let count = stream.read(&mut chunk).unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..count]);
            }
            let has_exact_header = String::from_utf8_lossy(&request).contains(&expected_header);
            stream.write_all(&response).unwrap();
            let _ = stream.shutdown(Shutdown::Both);
            has_exact_header
        });
        let connection = BackendConnection {
            host: DEFAULT_BACKEND_HOST.to_string(),
            port,
            auth_token: token.to_string(),
        };
        let result = probe_authenticated_health(&connection);
        let has_exact_header = server.join().expect("health test server thread panicked");
        (result, has_exact_header)
    }

    #[test]
    fn loopback_hosts_are_normalized_and_remote_hosts_rejected() {
        assert_eq!(normalize_loopback_host("localhost").unwrap(), "127.0.0.1");
        assert_eq!(normalize_loopback_host("[::1]").unwrap(), "::1");
        assert!(normalize_loopback_host("[::1").is_err());
        assert!(normalize_loopback_host("::1]").is_err());
        assert!(normalize_loopback_host("0.0.0.0").is_err());
        assert!(normalize_loopback_host("192.168.1.10").is_err());
    }

    #[test]
    fn configured_ports_never_fall_back_when_invalid() {
        assert_eq!(parse_configured_port("8765").unwrap(), 8765);
        assert!(parse_configured_port("0").is_err());
        assert!(parse_configured_port("not-a-port").is_err());
    }

    #[test]
    fn authenticated_health_requires_success_and_instance_identity() {
        assert!(parse_health_response(&response(
            "200 OK",
            r#"{"status":"ok","instance_id":"run-1"}"#
        ))
        .is_ok());
        assert!(parse_health_response(&response(
            "401 Unauthorized",
            r#"{"error":"Unauthorized"}"#
        ))
        .is_err());
        assert!(
            parse_health_response(&response("200 OK", r#"{"status":"ok","instance_id":""}"#))
                .is_err()
        );
        assert!(parse_health_response(b"not-http").is_err());
        assert!(parse_health_response(
            &b"NOTHTTP 200 OK\r\n\r\n{\"status\":\"ok\",\"instance_id\":\"run-1\"}"[..]
        )
        .is_err());
        assert!(parse_health_response(&response(
            "200 OK",
            r#"{"status":"starting","instance_id":"run-1"}"#
        ))
        .is_err());
        assert!(parse_health_response(&vec![b'x'; HEALTH_RESPONSE_LIMIT as usize + 1]).is_err());
    }

    #[test]
    fn authenticated_probe_sends_exact_header_and_accepts_valid_health() {
        assert_eq!(AUTH_HEADER_NAME, "X-Transcript-Research-Studio-Token");
        let (result, has_exact_header) = run_authenticated_probe(response(
            "200 OK",
            r#"{"status":"ok","instance_id":"run-1"}"#,
        ));
        assert!(result.is_ok(), "valid authenticated health was rejected");
        assert!(
            has_exact_header,
            "health request omitted the exact token header"
        );
    }

    #[test]
    fn authenticated_probe_rejects_unauthorized_health_without_exposing_token() {
        let (result, has_exact_header) =
            run_authenticated_probe(response("401 Unauthorized", r#"{"error":"Unauthorized"}"#));
        assert!(result.is_err(), "unauthorized health was accepted");
        assert!(
            has_exact_header,
            "health request omitted the exact token header"
        );
        assert!(!format!("{result:?}").contains("synthetic-request-token"));
    }

    #[test]
    fn authenticated_probe_rejects_malformed_json_and_missing_identity() {
        let (malformed, malformed_header) = run_authenticated_probe(response("200 OK", "not-json"));
        assert!(malformed.is_err(), "malformed health JSON was accepted");
        assert!(
            malformed_header,
            "health request omitted the exact token header"
        );

        let (missing_identity, missing_header) =
            run_authenticated_probe(response("200 OK", r#"{"status":"ok","instance_id":""}"#));
        assert!(
            missing_identity.is_err(),
            "missing health identity was accepted"
        );
        assert!(
            missing_header,
            "health request omitted the exact token header"
        );
    }

    #[test]
    fn per_launch_tokens_are_nonempty_and_fresh() {
        let first = generate_auth_token();
        let second = generate_auth_token();
        assert_eq!(first.len(), 64);
        assert_eq!(second.len(), 64);
        assert_ne!(first, second);
    }

    #[test]
    fn release_token_selection_always_generates_a_fresh_value() {
        let selected = select_auth_token(
            ExplicitToken::Value("ignored-development-token".to_string()),
            false,
            || "fresh-release-token".to_string(),
        )
        .unwrap();
        assert_eq!(selected, "fresh-release-token");
    }

    #[test]
    fn development_token_selection_trims_or_generates_as_required() {
        assert_eq!(
            select_auth_token(
                ExplicitToken::Value("  synthetic-development-token  ".to_string()),
                true,
                || "generated-token".to_string(),
            )
            .unwrap(),
            "synthetic-development-token"
        );
        assert_eq!(
            select_auth_token(ExplicitToken::Value("   ".to_string()), true, || {
                "generated-token".to_string()
            },)
            .unwrap(),
            "generated-token"
        );
    }

    #[test]
    fn development_token_selection_rejects_control_and_non_unicode_values() {
        let control_error = select_auth_token(
            ExplicitToken::Value("synthetic\r\ntoken".to_string()),
            true,
            || "generated-token".to_string(),
        )
        .unwrap_err();
        assert!(!control_error.contains("synthetic"));
        assert!(select_auth_token(ExplicitToken::NotUnicode, true, || {
            "generated-token".to_string()
        })
        .is_err());
    }

    #[test]
    fn occupied_port_is_rejected_before_sidecar_spawn() {
        let listener = TcpListener::bind((DEFAULT_BACKEND_HOST, 0)).unwrap();
        let connection = BackendConnection {
            host: DEFAULT_BACKEND_HOST.to_string(),
            port: listener.local_addr().unwrap().port(),
            auth_token: "synthetic-token".to_string(),
        };
        assert!(ensure_backend_port_available(&connection).is_err());
    }
}
