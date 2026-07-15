"use client";

import {
  type FormEvent,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";

import AppDialog from "@/components/app-dialog";
import {
  createOfflineEntryUiState,
  filterObligationsByName,
  ledgerErrorMessage,
  normalizeDisplayName,
  normalizeOfflineHits,
  reduceOfflineEntryUiState,
} from "@/lib/ledger/offline-entry.mjs";
import type {
  AddOfflineObligationInput,
  ProfileSearchResult,
} from "@/lib/ledger/offline-entry.types";
import type { Tables } from "@/lib/supabase/database.types";

type Obligation = Tables<"hit_obligations">;
type Profile = Tables<"profiles">;

type HitLedgerDialogProps = {
  open: boolean;
  busy: boolean;
  error: string;
  userId: string;
  profile: Profile | null;
  names: Record<string, string>;
  obligations: Obligation[];
  onClose: () => void;
  onRecordHit: (obligation: Obligation) => Promise<void>;
  onSearchProfiles: (query: string) => Promise<ProfileSearchResult[]>;
  onAddOfflineObligation: (input: AddOfflineObligationInput) => Promise<void>;
};

function quantityToBigInt(value: string | number): bigint | null {
  const normalized = String(value);
  if (!/^\d+$/.test(normalized)) return null;

  try {
    return BigInt(normalized);
  } catch {
    return null;
  }
}

function formatQuantity(value: string | number): string {
  const exact = quantityToBigInt(value);
  return exact === null ? String(value) : exact.toLocaleString("ko-KR");
}

function sumRemaining(obligations: Obligation[]): bigint {
  return obligations.reduce((total, obligation) => {
    const remaining = quantityToBigInt(obligation.remaining_hits);
    return remaining === null ? total : total + remaining;
  }, BigInt(0));
}

function normalizedHitsOrNull(value: string): string | null {
  try {
    return normalizeOfflineHits(value);
  } catch {
    return null;
  }
}

export default function HitLedgerDialog({
  open,
  busy,
  error,
  userId,
  profile,
  names,
  obligations,
  onClose,
  onRecordHit,
  onSearchProfiles,
  onAddOfflineObligation,
}: HitLedgerDialogProps) {
  const searchRequestRef = useRef(0);
  const submitRequestRef = useRef(0);
  const queryInputRef = useRef<HTMLInputElement>(null);
  const firstResultRef = useRef<HTMLButtonElement>(null);
  const pendingFocusRef = useRef<"first-result" | "query" | null>(null);
  const [entryState, dispatch] = useReducer(
    reduceOfflineEntryUiState,
    createOfflineEntryUiState(),
  );
  const [searchBusy, setSearchBusy] = useState(false);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [ledgerQuery, setLedgerQuery] = useState("");

  const normalizedHits = normalizedHitsOrNull(entryState.hits);
  const submitDisabled =
    busy ||
    searchBusy ||
    submitBusy ||
    !entryState.selectedProfile ||
    normalizedHits === null;
  const controlsBusy = busy || searchBusy || submitBusy;
  const visibleError = entryState.localError || error;
  const visibleObligations = filterObligationsByName(
    obligations,
    names,
    ledgerQuery,
  );
  const remainingToDeliver = sumRemaining(
    obligations.filter((item) => item.creditor_id === userId),
  );
  const remainingToReceive = sumRemaining(
    obligations.filter((item) => item.debtor_id === userId),
  );

  useEffect(() => {
    if (busy || searchBusy || submitBusy) return;
    const focusTarget = pendingFocusRef.current;
    if (!focusTarget) return;
    pendingFocusRef.current = null;

    if (focusTarget === "first-result") {
      firstResultRef.current?.focus();
    } else {
      queryInputRef.current?.focus();
    }
  }, [
    busy,
    entryState.hasSearched,
    entryState.localNotice,
    entryState.matches,
    searchBusy,
    submitBusy,
  ]);

  function handleClose() {
    searchRequestRef.current += 1;
    submitRequestRef.current += 1;
    pendingFocusRef.current = null;
    dispatch({
      type: "reset",
      requestToken: searchRequestRef.current,
    });
    setSearchBusy(false);
    setSubmitBusy(false);
    setLedgerQuery("");
    onClose();
  }

  function handleQueryChange(query: string) {
    const requestToken = ++searchRequestRef.current;
    pendingFocusRef.current = null;
    setSearchBusy(false);
    dispatch({ type: "query_changed", query, requestToken });
  }

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (controlsBusy) return;

    let normalizedQuery: string;
    try {
      normalizedQuery = normalizeDisplayName(entryState.query);
    } catch (error) {
      dispatch({
        type: "validation_failed",
        error:
          error instanceof Error
            ? error.message
            : "이름은 2~24자로 입력해 주세요.",
      });
      return;
    }

    const requestToken = ++searchRequestRef.current;
    dispatch({ type: "search_started", requestToken });
    setSearchBusy(true);
    try {
      const results = await onSearchProfiles(normalizedQuery);
      if (searchRequestRef.current !== requestToken) return;
      pendingFocusRef.current = results.length > 0 ? "first-result" : "query";
      dispatch({ type: "search_succeeded", requestToken, matches: results });
    } catch (error) {
      if (searchRequestRef.current !== requestToken) return;
      pendingFocusRef.current = "query";
      dispatch({
        type: "search_failed",
        requestToken,
        error: ledgerErrorMessage(error),
      });
    } finally {
      if (searchRequestRef.current === requestToken) {
        setSearchBusy(false);
      }
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    dispatch({ type: "feedback_cleared" });

    if (!entryState.selectedProfile) {
      dispatch({
        type: "validation_failed",
        error: "함께 기록할 계정을 이름으로 찾아 선택해 주세요.",
      });
      return;
    }

    let normalizedHits: string;
    try {
      normalizedHits = normalizeOfflineHits(entryState.hits);
    } catch (error) {
      dispatch({ type: "validation_failed", error: ledgerErrorMessage(error) });
      return;
    }

    if (busy || searchBusy || submitBusy) return;
    const requestId = ++submitRequestRef.current;
    setSubmitBusy(true);
    try {
      await onAddOfflineObligation({
        counterpartyId: entryState.selectedProfile.id,
        direction: entryState.direction,
        hits: normalizedHits,
      });
      if (submitRequestRef.current !== requestId) return;
      const requestToken = ++searchRequestRef.current;
      pendingFocusRef.current = "query";
      dispatch({
        type: "submit_succeeded",
        requestToken,
        notice: "오프라인 딱밤 빚을 양쪽 장부에 추가했어요.",
      });
    } catch (error) {
      if (submitRequestRef.current !== requestId) return;
      dispatch({ type: "submit_failed", error: ledgerErrorMessage(error) });
    } finally {
      if (submitRequestRef.current === requestId) {
        setSubmitBusy(false);
      }
    }
  }

  return (
    <AppDialog
      open={open}
      onClose={handleClose}
      titleId="ledger-dialog-title"
      descriptionId="ledger-dialog-description"
      className="app-dialog--ledger"
    >
      <div className="app-dialog__surface ledger-dialog">
        <header className="ledger-dialog__header">
          <div>
            <small>NO NETTING</small>
            <h2 id="ledger-dialog-title">전체 딱밤 장부</h2>
          </div>
          <button
            type="button"
            className="app-dialog__close"
            aria-label="딱밤 장부 닫기"
            onClick={handleClose}
          >
            ×
          </button>
        </header>

        <p id="ledger-dialog-description" className="ledger-dialog__description">
          서로 때릴 딱밤은 상계하지 않고 각각 남아요.
        </p>

        <dl className="ledger-dialog__summary" aria-label="딱밤 장부 요약">
          <div>
            <dt>내가 때릴 딱밤</dt>
            <dd>{remainingToDeliver.toLocaleString("ko-KR")}</dd>
          </div>
          <div>
            <dt>내가 맞을 딱밤</dt>
            <dd>{remainingToReceive.toLocaleString("ko-KR")}</dd>
          </div>
          <div>
            <dt>누적 때림</dt>
            <dd>{(profile?.hits_delivered ?? 0).toLocaleString("ko-KR")}</dd>
          </div>
          <div>
            <dt>누적 맞음</dt>
            <dd>{(profile?.hits_received ?? 0).toLocaleString("ko-KR")}</dd>
          </div>
        </dl>

        {visibleError && (
          <p className="ledger-dialog__notice" role="alert">
            {visibleError}
          </p>
        )}

        <div className="ledger-dialog__content">
          <section className="ledger-dialog__entry" aria-labelledby="offline-entry-title">
            <div className="ledger-dialog__sectionTitle">
              <div>
                <small>MANUAL ENTRY</small>
                <h3 id="offline-entry-title">오프라인 빚 추가</h3>
              </div>
              <span>즉시 양쪽 장부에 표시</span>
            </div>

            <fieldset className="ledger-dialog__direction" disabled={controlsBusy}>
              <legend>딱밤 방향</legend>
              <label>
                <input
                  type="radio"
                  name="offline-direction"
                  value="i_hit"
                  checked={entryState.direction === "i_hit"}
                  onChange={() =>
                    dispatch({ type: "direction_changed", direction: "i_hit" })
                  }
                />
                <span>내가 때릴</span>
              </label>
              <label>
                <input
                  type="radio"
                  name="offline-direction"
                  value="i_owe"
                  checked={entryState.direction === "i_owe"}
                  onChange={() =>
                    dispatch({ type: "direction_changed", direction: "i_owe" })
                  }
                />
                <span>내가 맞을</span>
              </label>
            </fieldset>

            <form className="ledger-dialog__search" onSubmit={handleSearch} noValidate>
              <label htmlFor="offline-profile-query">
                이름
              </label>
              <div>
                <input
                  ref={queryInputRef}
                  id="offline-profile-query"
                  type="search"
                  value={entryState.query}
                  required
                  minLength={2}
                  maxLength={24}
                  autoComplete="off"
                  placeholder="이름으로 계정 찾기"
                  disabled={busy || submitBusy}
                  onChange={(event) => handleQueryChange(event.target.value)}
                />
                <button type="submit" disabled={controlsBusy}>
                  {searchBusy ? "찾는 중…" : "검색"}
                </button>
              </div>
            </form>

            {entryState.matches.length > 0 && (
              <ul className="ledger-dialog__matches" aria-label="계정 검색 결과">
                {entryState.matches.map((profile, index) => (
                  <li key={profile.id}>
                    <button
                      ref={index === 0 ? firstResultRef : undefined}
                      type="button"
                      aria-pressed={entryState.selectedProfile?.id === profile.id}
                      disabled={controlsBusy}
                      onClick={() =>
                        dispatch({ type: "profile_selected", profile })
                      }
                    >
                      <b>{profile.display_name}</b>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p
              className={`ledger-dialog__searchStatus${
                entryState.hasSearched && entryState.matches.length === 0
                  ? " ledger-dialog__searchStatus--empty"
                  : ""
              }`}
              role="status"
              aria-live="polite"
            >
              {searchBusy
                ? "계정을 찾는 중이에요."
                : entryState.hasSearched
                  ? entryState.matches.length > 0
                    ? `검색 결과 ${entryState.matches.length}개`
                    : "일치하는 계정이 없어요. 이름을 다시 확인해 주세요."
                  : ""}
            </p>

            <form className="ledger-dialog__add" onSubmit={handleSubmit} noValidate>
              <label htmlFor="offline-hits">딱밤 횟수</label>
              <input
                id="offline-hits"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={entryState.hits}
                placeholder="1 이상의 정수"
                disabled={controlsBusy}
                onChange={(event) =>
                  dispatch({ type: "hits_changed", hits: event.target.value })
                }
                onBlur={() => {
                  if (entryState.hits.length === 0) return;
                  try {
                    normalizeOfflineHits(entryState.hits);
                  } catch (error) {
                    dispatch({
                      type: "validation_failed",
                      error: ledgerErrorMessage(error),
                    });
                  }
                }}
              />
              <button type="submit" disabled={submitDisabled}>
                {submitBusy ? "추가하는 중…" : "양쪽 장부에 추가"}
              </button>
            </form>

            {entryState.localNotice && (
              <p className="ledger-dialog__success" role="status">
                {entryState.localNotice}
              </p>
            )}
          </section>

          <section className="ledger-dialog__ledger" aria-labelledby="ledger-list-title">
            <div className="ledger-dialog__sectionTitle">
              <div>
                <small>OPEN OBLIGATIONS</small>
                <h3 id="ledger-list-title">남은 딱밤</h3>
              </div>
              <span>
                {visibleObligations.length} / {obligations.length}건
              </span>
            </div>

            <div className="ledger-dialog__ledgerSearch">
              <label htmlFor="global-ledger-query">전체 장부 이름 검색</label>
              <input
                id="global-ledger-query"
                type="search"
                value={ledgerQuery}
                placeholder="때릴 사람 또는 맞을 사람 이름"
                autoComplete="off"
                onChange={(event) => setLedgerQuery(event.target.value)}
              />
            </div>

            {obligations.length === 0 ? (
              <p className="ledger-dialog__empty">
                아직 전체 장부에 남은 딱밤 약속이 없어요.
              </p>
            ) : visibleObligations.length === 0 ? (
              <p className="ledger-dialog__empty">
                검색한 이름과 일치하는 장부가 없어요.
              </p>
            ) : (
              <ul className="ledger-dialog__list">
                {visibleObligations.map((item) => {
                  const remaining = quantityToBigInt(item.remaining_hits);
                  const canRecord =
                    item.creditor_id === userId &&
                    remaining !== null &&
                    remaining > BigInt(0);
                  const creditorName = names[item.creditor_id] ?? "플레이어";
                  const debtorName = names[item.debtor_id] ?? "플레이어";
                  const actionCopy = `${creditorName}이 ${debtorName}을 때릴 딱밤`;

                  return (
                    <li key={item.id}>
                      <div className="ledger-dialog__rowCopy">
                        <div className="ledger-dialog__rowTitle">
                          <span
                            className={`ledger-dialog__source ledger-dialog__source--${item.source}`}
                          >
                            {item.source === "offline" ? "오프라인" : "게임"}
                          </span>
                          <b>{actionCopy}</b>
                        </div>
                        <span className="ledger-dialog__rowMeta">
                          남음 {formatQuantity(item.remaining_hits)} · 완료{" "}
                          {item.delivered_hits.toLocaleString("ko-KR")}
                        </span>
                      </div>
                      {canRecord && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void onRecordHit(item)}
                        >
                          한 대 때림
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>

      <style jsx global>{`
        .ledger-dialog {
          color: #f6ead2;
          font-family: var(--font-sans, Arial, sans-serif);
        }
        .ledger-dialog__header,
        .ledger-dialog__sectionTitle,
        .ledger-dialog__rowTitle {
          display: flex;
          align-items: center;
        }
        .ledger-dialog__header,
        .ledger-dialog__sectionTitle {
          justify-content: space-between;
          gap: 16px;
        }
        .ledger-dialog__header small,
        .ledger-dialog__sectionTitle small {
          display: block;
          color: #d5a65e;
          font-size: 10px;
          font-weight: 800;
          letter-spacing: 0.18em;
        }
        .ledger-dialog__header h2 {
          margin: 4px 0 0;
          font-size: 22px;
        }
        .ledger-dialog__header button,
        .ledger-dialog__entry button,
        .ledger-dialog__list button {
          cursor: pointer;
          font: inherit;
        }
        .ledger-dialog button:disabled,
        .ledger-dialog input:disabled {
          cursor: not-allowed;
          opacity: 0.46;
        }
        .ledger-dialog__description {
          margin: 16px 0;
          color: #aeb8b3;
          font-size: 13px;
          line-height: 1.6;
        }
        .ledger-dialog__summary {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 7px;
          margin: 0;
        }
        .ledger-dialog__summary > div {
          min-width: 0;
          padding: 11px 8px;
          text-align: center;
          background: #0c1816;
          border: 1px solid rgba(221, 180, 106, 0.13);
          border-radius: 11px;
        }
        .ledger-dialog__summary dt {
          color: #929e98;
          font-size: 10px;
          line-height: 1.35;
        }
        .ledger-dialog__summary dd {
          margin: 5px 0 0;
          overflow-wrap: anywhere;
          color: #f2d7a7;
          font-size: 16px;
          font-weight: 850;
        }
        .ledger-dialog__notice,
        .ledger-dialog__success {
          margin: 14px 0 0;
          padding: 10px 12px;
          border-radius: 8px;
          font-size: 12px;
          line-height: 1.5;
        }
        .ledger-dialog__notice {
          color: #ffe0ba;
          background: #34251c;
          border-left: 3px solid #e09b54;
        }
        .ledger-dialog__success {
          color: #c9f5df;
          background: #15362c;
          border-left: 3px solid #5fc899;
        }
        .ledger-dialog__content {
          display: grid;
          grid-template-columns: minmax(0, 0.92fr) minmax(0, 1.08fr);
          align-items: start;
          gap: 18px;
          margin-top: 18px;
        }
        .ledger-dialog__entry,
        .ledger-dialog__ledger {
          min-width: 0;
          padding: 16px;
          background: linear-gradient(145deg, #10201d, #0b1715);
          border: 1px solid #2d3d38;
          border-radius: 14px;
        }
        .ledger-dialog__sectionTitle h3 {
          margin: 4px 0 0;
          font-size: 16px;
        }
        .ledger-dialog__sectionTitle > span {
          color: #87938d;
          font-size: 10px;
        }
        .ledger-dialog__direction {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
          margin: 16px 0 0;
          padding: 0;
          border: 0;
        }
        .ledger-dialog__direction legend,
        .ledger-dialog__search > label,
        .ledger-dialog__add > label {
          margin-bottom: 7px;
          color: #b8c0bb;
          font-size: 11px;
          font-weight: 750;
        }
        .ledger-dialog__direction legend {
          grid-column: 1 / -1;
        }
        .ledger-dialog__direction label {
          position: relative;
          display: flex;
          min-height: 44px;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          color: #aab4af;
          background: #0a1513;
          border: 1px solid #33443f;
          border-radius: 10px;
          font-size: 12px;
          font-weight: 800;
        }
        .ledger-dialog__direction input {
          position: absolute;
          width: 1px;
          height: 1px;
          opacity: 0;
        }
        .ledger-dialog__direction label:has(input:checked) {
          color: #ffe2ae;
          background: #382719;
          border-color: #cc914b;
        }
        .ledger-dialog__direction label:has(input:focus-visible) {
          outline: 2px solid #f4a06f;
          outline-offset: 3px;
        }
        .ledger-dialog__search,
        .ledger-dialog__add {
          display: grid;
          min-width: 0;
          margin-top: 16px;
        }
        .ledger-dialog__search > div {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 8px;
        }
        .ledger-dialog__entry input,
        .ledger-dialog__entry button,
        .ledger-dialog__list button {
          min-height: 44px;
        }
        .ledger-dialog__entry input {
          min-width: 0;
          width: 100%;
          padding: 10px 11px;
          color: #f8eedb;
          background: #091512;
          border: 1px solid #34443f;
          border-radius: 10px;
          outline: none;
        }
        .ledger-dialog__entry input:focus-visible {
          border-color: #d7a95e;
          box-shadow: 0 0 0 3px rgba(215, 169, 94, 0.14);
        }
        .ledger-dialog__search button,
        .ledger-dialog__add button {
          padding: 9px 14px;
          color: #20170d;
          background: linear-gradient(#e1b56b, #b97a32);
          border: 1px solid #e1b56b;
          border-radius: 10px;
          font-size: 12px;
          font-weight: 850;
        }
        .ledger-dialog__matches {
          display: grid;
          gap: 7px;
          max-height: 178px;
          margin: 9px 0 0;
          padding: 0;
          overflow: auto;
          list-style: none;
        }
        .ledger-dialog__matches button {
          min-width: 0;
          width: 100%;
          padding: 9px 11px;
          text-align: left;
          color: #e8eee8;
          background: #0a1513;
          border: 1px solid #31423d;
          border-radius: 10px;
        }
        .ledger-dialog__matches button[aria-pressed="true"] {
          color: #ffe2ae;
          background: #352519;
          border-color: #d29a52;
          box-shadow: inset 3px 0 #e7ad60;
        }
        .ledger-dialog__matches b {
          display: block;
          min-width: 0;
          overflow-wrap: anywhere;
          font-size: 12px;
        }
        .ledger-dialog__searchStatus {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          white-space: nowrap;
          border: 0;
        }
        .ledger-dialog__searchStatus--empty {
          position: static;
          width: auto;
          height: auto;
          margin: 9px 0 0;
          padding: 12px;
          overflow: visible;
          clip: auto;
          white-space: normal;
          color: #9ba7a1;
          text-align: center;
          background: #0a1513;
          border-radius: 9px;
          font-size: 11px;
        }
        .ledger-dialog__add button {
          margin-top: 9px;
        }
        .ledger-dialog__ledgerSearch {
          display: grid;
          gap: 6px;
          margin-top: 14px;
        }
        .ledger-dialog__ledgerSearch label {
          color: #b8c0bb;
          font-size: 11px;
          font-weight: 750;
        }
        .ledger-dialog__ledgerSearch input {
          min-height: 44px;
          min-width: 0;
          width: 100%;
          padding: 10px 11px;
          color: #f8eedb;
          background: #091512;
          border: 1px solid #34443f;
          border-radius: 10px;
          outline: none;
        }
        .ledger-dialog__ledgerSearch input:focus-visible {
          border-color: #d7a95e;
          box-shadow: 0 0 0 3px rgba(215, 169, 94, 0.14);
        }
        .ledger-dialog__empty {
          margin: 14px 0 0;
          padding: 24px 14px;
          color: #9da8a2;
          text-align: center;
          background: #0d1917;
          border: 1px dashed #34443f;
          border-radius: 12px;
          font-size: 13px;
        }
        .ledger-dialog__list {
          display: grid;
          gap: 8px;
          margin: 14px 0 0;
          padding: 0;
          list-style: none;
        }
        .ledger-dialog__list li {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 12px;
          background: #0d1917;
          border: 1px solid #2d3d38;
          border-radius: 12px;
        }
        .ledger-dialog__rowCopy {
          min-width: 0;
        }
        .ledger-dialog__rowTitle {
          min-width: 0;
          align-items: flex-start;
          gap: 7px;
        }
        .ledger-dialog__rowTitle b {
          min-width: 0;
          overflow-wrap: anywhere;
          font-size: 13px;
          line-height: 1.45;
        }
        .ledger-dialog__source {
          flex: 0 0 auto;
          margin-top: 1px;
          padding: 3px 6px;
          color: #cbd3ce;
          background: #263630;
          border: 1px solid #43554f;
          border-radius: 999px;
          font-size: 9px;
          font-weight: 850;
        }
        .ledger-dialog__source--offline {
          color: #ffdca4;
          background: #3a2819;
          border-color: #8e6232;
        }
        .ledger-dialog__rowMeta {
          display: block;
          margin-top: 5px;
          overflow-wrap: anywhere;
          color: #8e9994;
          font-size: 11px;
        }
        .ledger-dialog__list > li > button {
          min-width: 92px;
          flex: 0 0 auto;
          padding: 9px 12px;
          color: #ffe0ad;
          background: #3a281a;
          border: 1px solid #bd8140;
          border-radius: 10px;
          font-size: 11px;
          font-weight: 800;
        }
        .ledger-dialog__list > li > button:hover:not(:disabled) {
          background: #4a321e;
          border-color: #e0a35c;
        }
        @media (min-width: 601px) {
          .app-dialog--ledger {
            width: min(940px, calc(100vw - 24px));
          }
        }
        @media (max-width: 760px) {
          .ledger-dialog__content {
            grid-template-columns: 1fr;
          }
        }
        @media (max-width: 520px) {
          .ledger-dialog {
            padding: 20px 16px 18px;
          }
          .ledger-dialog__summary {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
          .ledger-dialog__entry,
          .ledger-dialog__ledger {
            padding: 14px;
          }
          .ledger-dialog__list li {
            align-items: stretch;
            flex-direction: column;
          }
          .ledger-dialog__list > li > button {
            width: 100%;
          }
        }
      `}</style>
    </AppDialog>
  );
}
