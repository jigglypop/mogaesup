use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

/// A refusal the client can act on: HTTP status, a stable code and a Korean message for the page.
#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: &'static str,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub const fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self { status, code, message }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({"code": self.code, "message": self.message}))).into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        tracing::error!(%error, "Database request failed");
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "database", "저장 서버 요청에 실패했습니다.")
    }
}

pub const fn bad(code: &'static str, message: &'static str) -> ApiError {
    ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, code, message)
}

pub const fn not_found(code: &'static str, message: &'static str) -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, code, message)
}

pub const fn forbidden(code: &'static str, message: &'static str) -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, code, message)
}

pub const fn conflict(code: &'static str, message: &'static str) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, code, message)
}

pub const LOGIN_REQUIRED: ApiError = ApiError::new(StatusCode::UNAUTHORIZED, "login_required", "로그인이 필요합니다.");

pub fn internal(error: impl std::fmt::Display) -> ApiError {
    tracing::error!(%error, "Request failed");
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", "잠시 후 다시 시도해 주세요.")
}
