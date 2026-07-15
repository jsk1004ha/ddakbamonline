"use client";

import AppDialog from "@/components/app-dialog";
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
  onSearchProfiles: (query: string) => Promise<Profile[]>;
  onAddOfflineObligation: (input: {
    counterpartyId: string;
    direction: "i_hit" | "i_owe";
    hits: string;
  }) => Promise<void>;
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
}: HitLedgerDialogProps) {
  const remainingToDeliver = sumRemaining(
    obligations.filter((item) => item.creditor_id === userId),
  );
  const remainingToReceive = sumRemaining(
    obligations.filter((item) => item.debtor_id === userId),
  );

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      titleId="ledger-dialog-title"
      descriptionId="ledger-dialog-description"
      className="app-dialog--ledger"
    >
      <div className="app-dialog__surface ledger-dialog">
        <header className="ledger-dialog__header">
          <div>
            <small>NO NETTING</small>
            <h2 id="ledger-dialog-title">내 딱밤 장부</h2>
          </div>
          <button
            type="button"
            className="app-dialog__close"
            aria-label="딱밤 장부 닫기"
            onClick={onClose}
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

        {error && (
          <p className="ledger-dialog__notice" role="alert">
            {error}
          </p>
        )}

        {obligations.length === 0 ? (
          <p className="ledger-dialog__empty">
            아직 계정에 남은 딱밤 약속이 없어요.
          </p>
        ) : (
          <ul className="ledger-dialog__list">
            {obligations.map((item) => {
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
                    <b>{actionCopy}</b>
                    <span>
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
      </div>

      <style jsx global>{`
        .ledger-dialog {
          color: #f6ead2;
          font-family: var(--font-sans, Arial, sans-serif);
        }
        .ledger-dialog__header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
        }
        .ledger-dialog__header small {
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
        .ledger-dialog__list button {
          cursor: pointer;
          font: inherit;
        }
        .ledger-dialog__header button:disabled,
        .ledger-dialog__list button:disabled {
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
        .ledger-dialog__notice {
          margin: 14px 0 0;
          padding: 10px 12px;
          color: #ffe0ba;
          background: #34251c;
          border-left: 3px solid #e09b54;
          border-radius: 8px;
          font-size: 12px;
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
        .ledger-dialog__rowCopy b {
          display: block;
          font-size: 13px;
          line-height: 1.45;
        }
        .ledger-dialog__rowCopy span {
          display: block;
          margin-top: 4px;
          color: #8e9994;
          font-size: 11px;
        }
        .ledger-dialog__list button {
          min-width: 92px;
          min-height: 44px;
          flex: 0 0 auto;
          padding: 9px 12px;
          color: #ffe0ad;
          background: #3a281a;
          border: 1px solid #bd8140;
          border-radius: 10px;
          font-size: 11px;
          font-weight: 800;
        }
        .ledger-dialog__list button:hover:not(:disabled) {
          background: #4a321e;
          border-color: #e0a35c;
        }
        @media (max-width: 520px) {
          .ledger-dialog {
            padding: 20px 16px 18px;
          }
          .ledger-dialog__summary {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
          .ledger-dialog__list li {
            align-items: stretch;
            flex-direction: column;
          }
          .ledger-dialog__list button {
            width: 100%;
          }
        }
      `}</style>
    </AppDialog>
  );
}
