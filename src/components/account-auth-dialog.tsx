"use client";

import { useState } from "react";

import AppDialog from "@/components/app-dialog";

export type AuthPayload = {
  mode: "signin" | "signup";
  loginId: string;
  password: string;
  displayName: string;
};

type AccountAuthDialogProps = {
  open: boolean;
  busy: boolean;
  error: string;
  notice: string;
  onClose: () => void;
  onSubmit: (payload: AuthPayload) => Promise<void>;
};

export default function AccountAuthDialog({
  open,
  busy,
  error,
  notice,
  onClose,
  onSubmit,
}: AccountAuthDialogProps) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      titleId="auth-dialog-title"
      descriptionId="auth-dialog-description"
    >
      <div className="app-dialog__surface auth-dialog">
        <header>
          <div>
            <small>DDACKBAM ID</small>
            <h2 id="auth-dialog-title">딱밤 계정으로 입장</h2>
          </div>
          <button
            type="button"
            className="app-dialog__close"
            aria-label="로그인 창 닫기"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <p id="auth-dialog-description">
          로그인하면 온라인 방과 계정별 딱밤 기록을 이용할 수 있어요.
        </p>
        <div className="accountRoom__tabs" role="tablist" aria-label="계정 메뉴">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "signin"}
            onClick={() => setMode("signin")}
          >
            로그인
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "signup"}
            onClick={() => setMode("signup")}
          >
            회원가입
          </button>
        </div>
        <form
          className="accountRoom__auth"
          onSubmit={async (event) => {
            event.preventDefault();
            await onSubmit({ mode, loginId, password, displayName });
            setPassword("");
          }}
        >
          {mode === "signup" && (
            <label>
              이름
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                minLength={2}
                maxLength={24}
                required
                autoComplete="nickname"
              />
            </label>
          )}
          <label>
            아이디
            <input
              type="text"
              value={loginId}
              onChange={(event) => setLoginId(event.target.value)}
              minLength={4}
              maxLength={20}
              pattern="[A-Za-z0-9_]{4,20}"
              required
              autoCapitalize="none"
              spellCheck={false}
              autoComplete="username"
            />
          </label>
          <label>
            비밀번호
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={8}
              required
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
            />
          </label>
          <button className="accountRoom__primary" disabled={busy}>
            {busy
              ? "처리 중…"
              : mode === "signup"
                ? "딱밤 계정 만들기"
                : "온라인 대전 시작"}
          </button>
        </form>
        {error && (
          <p className="accountRoom__notice" role="alert">
            {error}
          </p>
        )}
        {notice && !error && (
          <p className="accountRoom__notice" role="status">
            {notice}
          </p>
        )}
      </div>
    </AppDialog>
  );
}
