"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  applyAction,
  compareHands,
  createBettingState,
  dealRound,
  evaluateHand,
  type BettingState,
  type Card,
  type EvaluatedHand,
  type ExactInteger,
} from "@/lib/game/engine.mjs";
import {
  COMPACT_HAND_RANKING,
  handRankingGroup,
} from "@/lib/game/hand-ranking.mjs";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Json, Tables } from "@/lib/supabase/database.types";

type Room = Tables<"game_rooms">;

export type OnlineRoundState = {
  schema: 1;
  roundToken: string;
  roundNumber: number;
  playerIds: string[];
  hands: Record<string, Card[]>;
  betting: BettingState;
  phase: "betting" | "showdown";
  evaluations: Record<string, EvaluatedHand>;
  winnerIds: string[];
  resultRecorded: boolean;
};

export function createOnlineRound(
  playerIds: string[],
  roundNumber = 1,
): OnlineRoundState {
  return {
    schema: 1,
    roundToken: crypto.randomUUID(),
    roundNumber,
    playerIds,
    hands: dealRound(playerIds),
    betting: createBettingState(playerIds, "1"),
    phase: "betting",
    evaluations: {},
    winnerIds: [],
    resultRecorded: false,
  };
}

function readOnlineRound(value: Json): OnlineRoundState | null {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schema !== 1 ||
    typeof candidate.roundToken !== "string" ||
    !Array.isArray(candidate.playerIds) ||
    !candidate.hands ||
    !candidate.betting ||
    (candidate.phase !== "betting" && candidate.phase !== "showdown")
  ) {
    return null;
  }
  return value as unknown as OnlineRoundState;
}

function exact(value: number | string | bigint): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

function formatted(value: number | string | bigint): string {
  return exact(value).toLocaleString("ko-KR");
}

function resolveShowdown(
  round: OnlineRoundState,
  betting: BettingState,
): OnlineRoundState {
  const evaluations = Object.fromEntries(
    round.playerIds.map((playerId) => [playerId, evaluateHand(round.hands[playerId])]),
  );
  const bestId = round.playerIds.reduce((best, playerId) =>
    compareHands(evaluations[playerId], evaluations[best]) > 0 ? playerId : best,
  );
  const winnerIds = round.playerIds.filter(
    (playerId) => compareHands(evaluations[playerId], evaluations[bestId]) === 0,
  );
  return {
    ...round,
    betting,
    phase: "showdown",
    evaluations,
    winnerIds,
    resultRecorded: false,
  };
}

type Props = {
  room: Room;
  names: Record<string, string>;
  userId: string;
  onRefreshRoom: (roomId: string) => Promise<void>;
  onRefreshLedger: (accountId: string) => Promise<void>;
  onNotice: (message: string) => void;
};

export default function OnlineRoomGame({
  room,
  names,
  userId,
  onRefreshRoom,
  onRefreshLedger,
  onNotice,
}: Props) {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [raiseAmount, setRaiseAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const recording = useRef(new Set<string>());
  const round = readOnlineRound(room.state);
  const myHand = round?.hands[userId];
  const myEvaluation = myHand ? evaluateHand(myHand) : null;
  const currentRankingGroup = myEvaluation
    ? handRankingGroup(myEvaluation.name)
    : null;

  const commitRound = useCallback(
    async (nextRound: OnlineRoundState) => {
      if (!supabase) return false;
      setBusy(true);
      const { data, error } = await supabase
        .from("game_rooms")
        .update({
          state: nextRound as unknown as Json,
          version: room.version + 1,
        })
        .eq("id", room.id)
        .eq("version", room.version)
        .select("version")
        .maybeSingle();
      setBusy(false);
      if (error) {
        onNotice(error.message);
        return false;
      }
      if (!data) {
        onNotice("다른 계정의 행동이 먼저 반영됐어요. 최신 판으로 다시 맞췄습니다.");
        await onRefreshRoom(room.id);
        return false;
      }
      await onRefreshRoom(room.id);
      return true;
    },
    [onNotice, onRefreshRoom, room.id, room.version, supabase],
  );

  const persistResult = useCallback(
    async (finished: OnlineRoundState) => {
      if (!supabase) return;
      const soleWinner = finished.winnerIds.length === 1 ? finished.winnerIds[0] : null;
      const recorderId = soleWinner ?? room.host_id;
      if (recorderId !== userId || finished.resultRecorded) return;

      const existing = await supabase
        .from("game_results")
        .select("id")
        .eq("round_token", finished.roundToken)
        .maybeSingle();
      if (existing.error) throw existing.error;
      let resultId = existing.data?.id;

      if (!resultId) {
        const inserted = await supabase
          .from("game_results")
          .insert({
            room_id: room.id,
            round_token: finished.roundToken,
            winner_id: soleWinner,
            player_ids: finished.playerIds,
            stake: String(finished.betting.currentStake),
          })
          .select("id")
          .single();
        if (inserted.error?.code === "23505") {
          const retried = await supabase
            .from("game_results")
            .select("id")
            .eq("round_token", finished.roundToken)
            .single();
          if (retried.error) throw retried.error;
          resultId = retried.data.id;
        } else if (inserted.error) {
          throw inserted.error;
        } else {
          resultId = inserted.data.id;
        }
      }

      if (soleWinner && resultId) {
        const stake = String(finished.betting.currentStake);
        const obligations = finished.playerIds
          .filter((playerId) => playerId !== soleWinner)
          .map((debtorId) => ({
            game_result_id: resultId,
            room_id: room.id,
            debtor_id: debtorId,
            creditor_id: soleWinner,
            initial_hits: stake,
            remaining_hits: stake,
            delivered_hits: 0,
          }));
        const obligationResponse = await supabase.from("hit_obligations").upsert(
          obligations,
          {
            onConflict: "game_result_id,debtor_id,creditor_id",
            ignoreDuplicates: true,
          },
        );
        if (obligationResponse.error) throw obligationResponse.error;
      }

      await onRefreshLedger(userId);
      const marked = await commitRound({ ...finished, resultRecorded: true });
      if (!marked) recording.current.delete(finished.roundToken);
    },
    [commitRound, onRefreshLedger, room.host_id, room.id, supabase, userId],
  );

  useEffect(() => {
    if (!round || round.phase !== "showdown" || round.resultRecorded) return;
    const recorderId = round.winnerIds.length === 1 ? round.winnerIds[0] : room.host_id;
    if (recorderId !== userId || recording.current.has(round.roundToken)) return;
    recording.current.add(round.roundToken);
    void persistResult(round)
      .catch((error: unknown) => {
        recording.current.delete(round.roundToken);
        onNotice(error instanceof Error ? error.message : "결과 저장에 실패했어요.");
      });
  }, [onNotice, persistResult, room.host_id, round, userId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const gameWindow = window as Window & {
      render_game_to_text?: () => string;
      advanceTime?: (milliseconds: number) => void;
    };
    gameWindow.render_game_to_text = () => JSON.stringify({
      mode: "online",
      roundNumber: round?.roundNumber ?? null,
      phase: round?.phase ?? "waiting",
      userId,
      myHandName: myEvaluation?.name ?? null,
      turnPlayerId: round?.betting.turnPlayerId ?? null,
      currentStake: round ? String(round.betting.currentStake) : null,
      playerIds: round?.playerIds ?? [],
    });
    gameWindow.advanceTime = (milliseconds: number) => {
      void milliseconds;
      return undefined;
    };
    return () => {
      delete gameWindow.render_game_to_text;
      delete gameWindow.advanceTime;
    };
  }, [myEvaluation?.name, round, userId]);

  async function act(action: { type: "call" } | { type: "raise"; amount: ExactInteger }) {
    if (!round || round.phase !== "betting" || round.betting.turnPlayerId !== userId) return;
    try {
      const betting = applyAction(round.betting, userId, action);
      setRaiseAmount("");
      await commitRound(
        betting.status === "complete"
          ? resolveShowdown(round, betting)
          : { ...round, betting },
      );
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "행동을 처리하지 못했어요.");
    }
  }

  function raise() {
    if (!round) return;
    if (!/^\d+$/.test(raiseAmount)) {
      onNotice("올릴 총 딱밤을 숫자로 입력해 주세요.");
      return;
    }
    if (exact(raiseAmount) <= exact(round.betting.currentStake)) {
      onNotice(`현재 ${formatted(round.betting.currentStake)}보다 큰 정수를 입력해 주세요.`);
      return;
    }
    void act({ type: "raise", amount: raiseAmount });
  }

  if (!round) {
    return (
      <section className="onlineGame onlineGame--loading">
        <strong>온라인 패를 준비하고 있어요</strong>
        <span>방장이 판을 시작하면 2~4개 계정에 패가 배분됩니다.</span>
        <OnlineStyles />
      </section>
    );
  }

  const isMyTurn = round.phase === "betting" && round.betting.turnPlayerId === userId;
  const winnerText = round.winnerIds.length === 1
    ? `${names[round.winnerIds[0]] ?? "플레이어"} 승리`
    : "공동 1위 · 채무 없음";

  return (
    <section className="onlineGame" aria-labelledby="online-game-heading">
      <header>
        <div><small>REALTIME TABLE · ROUND {round.roundNumber}</small><h3 id="online-game-heading">계정 방 실전판</h3></div>
        <span>{round.phase === "betting" ? `판 딱밤 ${formatted(round.betting.currentStake)}` : winnerText}</span>
      </header>

      <div className={`onlineGame__seats onlineGame__seats--${round.playerIds.length}`}>
        {round.playerIds.map((playerId) => {
          const reveal = round.phase === "showdown" || playerId === userId;
          const isTurn = round.phase === "betting" && round.betting.turnPlayerId === playerId;
          return (
            <article key={playerId} className={isTurn ? "is-turn" : ""}>
              <div><strong>{names[playerId] ?? "플레이어"}{playerId === userId ? " · 나" : ""}</strong><small>{isTurn ? "현재 차례" : `받음 ${formatted(round.betting.commitments[playerId] ?? 0)}`}</small></div>
              <div className="onlineGame__cards">
                {round.hands[playerId]?.map((card) => (
                  // Source artwork is served from the attributed local card set.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={card.id} src={reveal ? `/cards/${card.imageId}.png` : "/cards/back.png"} width="72" height="106" alt={reveal ? `${card.month}월 패` : "뒤집힌 패"} />
                ))}
              </div>
              {playerId === userId && myEvaluation && (
                <details className="onlineGame__rankRollup">
                  <summary><strong>내 패 · {myEvaluation.name}</strong><span>족보 보기</span></summary>
                  <div className="onlineGame__rankList">
                    {COMPACT_HAND_RANKING.map((group) => (
                      <div key={group.id} className={currentRankingGroup === group.id ? "is-current" : ""}>
                        <b>{group.label}</b>
                        <span>{group.summary}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
              {round.phase === "showdown" && <b className="onlineGame__hand">{round.evaluations[playerId]?.name}</b>}
            </article>
          );
        })}
      </div>

      <div className="onlineGame__actions" aria-live="polite">
        {round.phase === "showdown" ? (
          <>
            <div><strong>{winnerText}</strong><span>{round.resultRecorded ? "계정 장부 저장 완료" : "계정 장부 저장 중…"}</span></div>
            {room.host_id === userId && (
              <button type="button" disabled={busy || !round.resultRecorded} onClick={() => void commitRound(createOnlineRound(round.playerIds, round.roundNumber + 1))}>다음 판</button>
            )}
          </>
        ) : isMyTurn ? (
          <>
            <button type="button" disabled={busy} onClick={() => void act({ type: "call" })}>받기 <small>{formatted(round.betting.currentStake)}에 맞춤</small></button>
            <label>올릴 총 딱밤<input value={raiseAmount} onChange={(event) => setRaiseAmount(event.target.value.trim())} inputMode="numeric" pattern="[0-9]*" placeholder={(exact(round.betting.currentStake) + BigInt(1)).toString()} /></label>
            <button type="button" disabled={busy} onClick={raise}>올리기</button>
          </>
        ) : (
          <span>{names[round.betting.turnPlayerId ?? ""] ?? "다른 계정"}의 차례를 기다리는 중…</span>
        )}
      </div>
      <p className="onlineGame__privacy">각 화면에는 자기 패만 먼저 보이며, 쇼다운 때 전부 공개됩니다.</p>
      <OnlineStyles />
    </section>
  );
}

function OnlineStyles() {
  return <style jsx global>{`
    .onlineGame{margin-top:15px;padding:15px;border:1px solid rgba(211,164,86,.28);border-radius:16px;background:radial-gradient(circle at 50% 45%,#17443b,#0c211e 64%,#091512);color:#f7ecd8}.onlineGame--loading{display:flex;flex-direction:column;gap:4px}.onlineGame--loading span,.onlineGame__privacy{color:#8fa49c;font-size:11px}.onlineGame>header{display:flex;justify-content:space-between;align-items:center;gap:12px}.onlineGame>header small{color:#d9a553;font-size:9px;letter-spacing:.13em}.onlineGame>header h3{margin:3px 0 0}.onlineGame>header>span{padding:7px 9px;border-radius:9px;background:#081613;color:#ffdca5;font-size:11px;font-weight:800}
    .onlineGame__seats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:12px}.onlineGame__seats article{display:grid;grid-template-columns:1fr auto;gap:7px;padding:9px;border:1px solid #2f5148;border-radius:12px;background:rgba(6,20,17,.72)}.onlineGame__seats article.is-turn{border-color:#e0a657;box-shadow:0 0 0 2px rgba(224,166,87,.13)}.onlineGame__seats article strong{display:block;font-size:11px}.onlineGame__seats article small{color:#8ba097;font-size:9px}.onlineGame__cards{grid-column:2;grid-row:1/3;display:flex}.onlineGame__cards img{width:38px;height:56px;object-fit:cover;border-radius:4px;border:1px solid #d2bd94;box-shadow:0 4px 9px rgba(0,0,0,.3)}.onlineGame__cards img+img{margin-left:-14px;transform:rotate(3deg)}.onlineGame__hand{align-self:end;color:#f0b75f;font-size:11px}
    .onlineGame__actions{display:flex;align-items:end;gap:7px;margin-top:10px;padding:10px;border-radius:12px;background:#071411}.onlineGame__actions>span{color:#b3c2bc;font-size:12px}.onlineGame__actions>div{margin-right:auto}.onlineGame__actions>div strong,.onlineGame__actions>div span{display:block}.onlineGame__actions>div span{color:#91a49d;font-size:9px}.onlineGame__actions button{min-height:39px;padding:7px 12px;border:1px solid #db9d4e;border-radius:9px;background:linear-gradient(#db9d4e,#a9662c);color:#21160c;font-weight:900}.onlineGame__actions button small{display:block;font-size:8px}.onlineGame__actions button:disabled{opacity:.45}.onlineGame__actions label{color:#9dafaa;font-size:9px}.onlineGame__actions input{display:block;width:125px;margin-top:4px;padding:9px;border:1px solid #3c554e;border-radius:8px;background:#10231f;color:#fff}.onlineGame__actions input:focus{outline:2px solid #e0a657;outline-offset:1px}.onlineGame__privacy{margin:8px 0 0;text-align:center}
    @media(max-width:560px){.onlineGame__seats{grid-template-columns:1fr}.onlineGame__actions{align-items:stretch;flex-wrap:wrap}.onlineGame__actions label{flex:1}.onlineGame__actions input{width:100%;box-sizing:border-box}}
  `}</style>;
}
