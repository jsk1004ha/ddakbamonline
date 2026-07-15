"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { User } from "@supabase/supabase-js";

import AccountAuthDialog, {
  type AuthPayload,
} from "@/components/account-auth-dialog";
import HitLedgerDialog from "@/components/hit-ledger-dialog";
import OnlineRoomGame from "@/components/online-room-game";

import { accountIdEmail } from "@/lib/auth/account-id";
import {
  canStartRoom,
  findFirstFreeSeat,
  generateRoomCode,
  normalizeRoomCode,
} from "@/lib/rooms";
import {
  getSupabaseBrowserClient,
  isSupabaseConfigured,
} from "@/lib/supabase/client";
import type { Tables } from "@/lib/supabase/database.types";

type Profile = Tables<"profiles">;
type Room = Tables<"game_rooms">;
type Member = Tables<"room_members">;
type Obligation = Tables<"hit_obligations">;

function errorMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : error &&
          typeof error === "object" &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : "";
  if (!message) return "요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.";
  if (/stale (?:room version|remaining hit count)/i.test(message)) {
    return "다른 기기에서 먼저 반영했어요. 최신 상태로 다시 맞췄습니다.";
  }
  if (/room is full|duplicate key/i.test(message)) return "방이 가득 찼거나 자리가 방금 선택됐어요.";
  if (/room is not available/i.test(message)) return "입장할 수 없는 방이에요.";
  return message;
}

function authErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "계정 요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.";
  if (/invalid login credentials/i.test(error.message)) return "아이디 또는 비밀번호가 맞지 않아요.";
  if (/already registered|user already exists/i.test(error.message)) return "이미 사용 중인 아이디예요.";
  if (/password.*(?:at least|characters)|weak password/i.test(error.message)) {
    return "비밀번호는 8자 이상으로 입력해 주세요.";
  }
  if (/^(?:아이디|닉네임)/.test(error.message)) return error.message;
  return "계정 요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.";
}

export default function AccountRoomPanel() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [obligations, setObligations] = useState<Obligation[]>([]);
  const [authOpen, setAuthOpen] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [ledgerBusy, setLedgerBusy] = useState(false);
  const [ledgerError, setLedgerError] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [roomBusy, setRoomBusy] = useState(false);
  const [roomNotice, setRoomNotice] = useState("");

  const loadProfiles = useCallback(
    async (ids: string[]) => {
      if (!supabase || ids.length === 0) return;
      const uniqueIds = [...new Set(ids)];
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .in("id", uniqueIds);
      if (error) throw error;
      const next = Object.fromEntries(
        (data ?? []).map((item) => [item.id, item.display_name]),
      );
      setNames((current) => ({ ...current, ...next }));
    },
    [supabase],
  );

  const refreshLedger = useCallback(
    async (accountId: string) => {
      if (!supabase) return;
      const { data, error } = await supabase
        .from("hit_obligations")
        .select("*")
        .or(`debtor_id.eq.${accountId},creditor_id.eq.${accountId}`)
        .order("created_at", { ascending: false });
      if (error) throw error;
      const rows = data ?? [];
      setObligations(rows);
      await loadProfiles(rows.flatMap((item) => [item.debtor_id, item.creditor_id]));
    },
    [loadProfiles, supabase],
  );

  const refreshRoom = useCallback(
    async (roomId: string) => {
      if (!supabase) return;
      const [roomResponse, membersResponse] = await Promise.all([
        supabase.from("game_rooms").select("*").eq("id", roomId).maybeSingle(),
        supabase
          .from("room_members")
          .select("*")
          .eq("room_id", roomId)
          .order("seat"),
      ]);
      if (roomResponse.error) throw roomResponse.error;
      if (membersResponse.error) throw membersResponse.error;
      setRoom(roomResponse.data);
      const nextMembers = membersResponse.data ?? [];
      setMembers(nextMembers);
      await loadProfiles(nextMembers.map((member) => member.user_id));
    },
    [loadProfiles, supabase],
  );

  const refreshAccount = useCallback(
    async (accountId: string) => {
      if (!supabase) return;
      const [profileResponse, membershipResponse] = await Promise.all([
        supabase.from("profiles").select("*").eq("id", accountId).maybeSingle(),
        supabase
          .from("room_members")
          .select("room_id")
          .eq("user_id", accountId)
          .limit(1)
          .maybeSingle(),
        refreshLedger(accountId),
      ]);
      if (profileResponse.error) throw profileResponse.error;
      if (membershipResponse.error) throw membershipResponse.error;
      const nextProfile = profileResponse.data;
      setProfile(nextProfile);
      if (nextProfile) {
        setNames((current) => ({
          ...current,
          [nextProfile.id]: nextProfile.display_name,
        }));
      }
      if (membershipResponse.data) {
        await refreshRoom(membershipResponse.data.room_id);
      } else {
        setRoom(null);
        setMembers([]);
      }
    },
    [refreshLedger, refreshRoom, supabase],
  );

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      const nextUser = data.session?.user ?? null;
      setUser(nextUser);
      if (nextUser) {
        setAuthOpen(false);
        setAuthError("");
      }
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      const nextUser = session?.user ?? null;
      setUser(nextUser);
      if (nextUser) {
        setAuthOpen(false);
        setAuthError("");
      }
      if (!session) {
        setProfile(null);
        setRoom(null);
        setMembers([]);
        setObligations([]);
      }
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [supabase]);

  useEffect(() => {
    if (!user) return;
    const timeout = window.setTimeout(() => {
      void refreshAccount(user.id).catch((error) => setRoomNotice(errorMessage(error)));
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [refreshAccount, user]);

  useEffect(() => {
    if (!supabase || !user) return;
    const channel = supabase
      .channel(`account-room-${user.id}-${room?.id ?? "none"}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "hit_obligations", filter: `debtor_id=eq.${user.id}` },
        () => void refreshLedger(user.id),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "hit_obligations", filter: `creditor_id=eq.${user.id}` },
        () => void refreshLedger(user.id),
      );
    if (room) {
      channel
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "room_members", filter: `room_id=eq.${room.id}` },
          () => void refreshRoom(room.id),
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "game_rooms", filter: `id=eq.${room.id}` },
          () => void refreshRoom(room.id),
        );
    }
    channel.subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [refreshLedger, refreshRoom, room, supabase, user]);

  async function handleAuth(payload: AuthPayload) {
    if (!supabase) return;
    setAuthBusy(true);
    setAuthError("");
    setAuthNotice("");
    try {
      const email = accountIdEmail(payload.loginId);
      if (payload.mode === "signup") {
        const cleanName = payload.displayName.trim();
        if (cleanName.length < 2 || cleanName.length > 24) {
          throw new Error("닉네임은 2~24자로 입력해 주세요.");
        }
        const { data, error } = await supabase.auth.signUp({
          email,
          password: payload.password,
          options: {
            data: { display_name: cleanName },
          },
        });
        if (error) throw error;
        if (!data.session) {
          setAuthNotice("가입이 완료됐어요. 같은 아이디로 로그인해 주세요.");
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password: payload.password,
        });
        if (error) throw error;
      }
    } catch (error) {
      setAuthError(authErrorMessage(error));
    } finally {
      setAuthBusy(false);
    }
  }

  async function createRoom() {
    if (!supabase || !user) return;
    setRoomBusy(true);
    setRoomNotice("");
    try {
      let created: Room | null = null;
      for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
        const { data, error } = await supabase
          .from("game_rooms")
          .insert({ code: generateRoomCode(), host_id: user.id, max_players: maxPlayers })
          .select("*")
          .single();
        if (!error) created = data;
        else if (error.code !== "23505") throw error;
      }
      if (!created) throw new Error("방 코드를 만들지 못했어요. 다시 시도해 주세요.");
      const { error } = await supabase
        .from("room_members")
        .insert({ room_id: created.id, user_id: user.id, seat: 0 });
      if (error) {
        await supabase.from("game_rooms").delete().eq("id", created.id);
        throw error;
      }
      await refreshRoom(created.id);
      setRoomNotice(`방 ${created.code}를 만들었어요.`);
    } catch (error) {
      setRoomNotice(errorMessage(error));
    } finally {
      setRoomBusy(false);
    }
  }

  async function joinRoom(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !user) return;
    const code = normalizeRoomCode(roomCode);
    if (code.length !== 6) {
      setRoomNotice("6자리 방 코드를 입력해 주세요.");
      return;
    }
    setRoomBusy(true);
    setRoomNotice("");
    try {
      const { data: target, error: roomError } = await supabase
        .from("game_rooms")
        .select("*")
        .eq("code", code)
        .eq("status", "waiting")
        .single();
      if (roomError) throw new Error("대기 중인 방을 찾지 못했어요.");
      const { data: occupied, error: membersError } = await supabase
        .from("room_members")
        .select("seat")
        .eq("room_id", target.id);
      if (membersError) throw membersError;
      const seat = findFirstFreeSeat(occupied ?? [], target.max_players);
      if (seat === null) throw new Error("방이 가득 찼어요.");
      const { error } = await supabase
        .from("room_members")
        .insert({ room_id: target.id, user_id: user.id, seat });
      if (error) throw error;
      await refreshRoom(target.id);
      setRoomCode("");
      setRoomNotice(`${target.code} 방에 입장했어요.`);
    } catch (error) {
      setRoomNotice(errorMessage(error));
    } finally {
      setRoomBusy(false);
    }
  }

  async function toggleReady() {
    if (!supabase || !user || !room) return;
    const mine = members.find((member) => member.user_id === user.id);
    if (!mine) return;
    setRoomBusy(true);
    const { error } = await supabase
      .from("room_members")
      .update({ ready: !mine.ready })
      .eq("room_id", room.id)
      .eq("user_id", user.id);
    if (error) setRoomNotice(errorMessage(error));
    else await refreshRoom(room.id);
    setRoomBusy(false);
  }

  async function leaveRoom() {
    if (!supabase || !user || !room) return;
    setRoomBusy(true);
    const response = room.host_id === user.id
      ? await supabase.from("game_rooms").delete().eq("id", room.id)
      : await supabase
          .from("room_members")
          .delete()
          .eq("room_id", room.id)
          .eq("user_id", user.id);
    if (response.error) setRoomNotice(errorMessage(response.error));
    else {
      setRoom(null);
      setMembers([]);
      setRoomNotice(room.host_id === user.id ? "방을 닫았어요." : "방에서 나왔어요.");
    }
    setRoomBusy(false);
  }

  async function startRoom() {
    if (!supabase || !user || !room || room.host_id !== user.id) return;
    if (!canStartRoom(members, room.max_players)) {
      setRoomNotice("2~4명이 모두 준비해야 시작할 수 있어요.");
      return;
    }
    setRoomBusy(true);
    const { error } = await supabase.rpc("start_game_round", {
      target_room: room.id,
      expected_version: room.version,
    });
    if (error) {
      setRoomNotice(errorMessage(error));
      await refreshRoom(room.id);
    } else {
      await refreshRoom(room.id);
      setRoomNotice("온라인 계정 대전을 시작했어요.");
    }
    setRoomBusy(false);
  }

  async function recordHit(obligation: Obligation) {
    if (!supabase || !user || obligation.creditor_id !== user.id) return;
    const normalized = String(obligation.remaining_hits);
    if (!/^\d+$/.test(normalized)) return;
    const remaining = BigInt(normalized);
    if (remaining <= BigInt(0)) return;
    setLedgerBusy(true);
    setLedgerError("");
    try {
      const { error } = await supabase.rpc("record_physical_hit", {
        obligation_id: obligation.id,
        expected_remaining: normalized,
      });
      if (error) {
        setLedgerError(errorMessage(error));
      } else {
        setLedgerError("");
      }
      await refreshAccount(user.id);
    } catch (error) {
      setLedgerError(errorMessage(error));
    } finally {
      setLedgerBusy(false);
    }
  }

  if (!isSupabaseConfigured() || !supabase) {
    return (
      <aside className="accountRoom accountRoom--empty">
        <strong>온라인 계정 연결 대기 중</strong>
        <span>환경 변수가 설정되면 회원가입·4인 방·계정별 딱밤 장부가 열려요.</span>
      </aside>
    );
  }

  const mine = user
    ? members.find((member) => member.user_id === user.id)
    : undefined;
  const startable = canStartRoom(members, room?.max_players ?? 4);

  return (
    <>
      <aside className="accountRoom">
        {!user ? (
          <section className="online-shell__gate">
            <span className="eyebrow">SUPABASE REALTIME</span>
            <h1>로그인이 필요해요</h1>
            <p>방을 만들거나 참가하려면 딱밤 계정으로 로그인해 주세요.</p>
            <button
              type="button"
              className="accountRoom__primary"
              onClick={() => setAuthOpen(true)}
            >
              로그인하고 시작
            </button>
          </section>
        ) : (
          <>
      <header className="accountRoom__header">
        <div><small>ACCOUNT LEDGER</small><h2>{profile?.display_name ?? "플레이어"}</h2></div>
        <div className="accountRoom__headerActions">
          <button className="accountRoom__ledgerTrigger" type="button" onClick={() => { setLedgerError(""); setLedgerOpen(true); }}>딱밤 장부 · {obligations.length}건</button>
          <button className="accountRoom__ghost" type="button" disabled={roomBusy} onClick={() => void supabase.auth.signOut()}>로그아웃</button>
        </div>
      </header>

      <div className="accountRoom__stats" aria-label="계정 전적">
        <span><b>{profile?.games_played ?? 0}</b> 게임</span>
        <span><b>{profile?.games_won ?? 0}</b> 승</span>
        <span><b>{profile?.hits_delivered ?? 0}</b> 때림</span>
        <span><b>{profile?.hits_received ?? 0}</b> 맞음</span>
      </div>

      {!room ? (
        <section className="accountRoom__lobby" aria-labelledby="room-heading">
          <div><small>ONLINE ROOM</small><h3 id="room-heading">2~4인 계정 방</h3></div>
          <div className="accountRoom__create">
            <label>최대 인원<select value={maxPlayers} onChange={(event) => setMaxPlayers(Number(event.target.value))}><option value={2}>2명</option><option value={3}>3명</option><option value={4}>4명</option></select></label>
            <button className="accountRoom__primary" type="button" disabled={roomBusy} onClick={() => void createRoom()}>새 방 만들기</button>
          </div>
          <form className="accountRoom__join" onSubmit={joinRoom}>
            <label htmlFor="room-code">방 코드</label>
            <input id="room-code" value={roomCode} onChange={(event) => setRoomCode(normalizeRoomCode(event.target.value))} maxLength={6} placeholder="ABC234" autoComplete="off" />
            <button className="accountRoom__ghost" disabled={roomBusy}>입장</button>
          </form>
        </section>
      ) : (
        <section className="accountRoom__room" aria-labelledby="active-room-heading">
          <div className="accountRoom__roomTitle">
            <div><small>ROOM CODE</small><h3 id="active-room-heading">{room.code}</h3></div>
            <span className={`accountRoom__status accountRoom__status--${room.status}`}>{room.status === "waiting" ? "대기 중" : room.status === "playing" ? "게임 중" : "정산 중"}</span>
          </div>
          <ol className="accountRoom__roster">
            {Array.from({ length: room.max_players }, (_, seat) => {
              const member = members.find((item) => item.seat === seat);
              return <li key={seat} className={member ? "is-filled" : ""}><span>{seat + 1}</span><b>{member ? names[member.user_id] ?? "플레이어" : "빈 자리"}</b>{member && <em>{member.ready ? "준비" : "대기"}{member.user_id === room.host_id ? " · 방장" : ""}</em>}</li>;
            })}
          </ol>
          <div className="accountRoom__actions">
            {room.status === "waiting" && <button className={mine?.ready ? "accountRoom__ready is-ready" : "accountRoom__ready"} type="button" disabled={roomBusy} onClick={() => void toggleReady()}>{mine?.ready ? "준비 완료" : "준비하기"}</button>}
            {room.host_id === user.id && room.status === "waiting" && <button className="accountRoom__primary" type="button" disabled={roomBusy || !startable} onClick={() => void startRoom()}>4인까지 시작</button>}
            <button className="accountRoom__ghost" type="button" disabled={roomBusy || room.status === "playing"} onClick={() => void leaveRoom()}>{room.status === "playing" ? "판 진행 중" : room.host_id === user.id ? "방 닫기" : "나가기"}</button>
          </div>
        </section>
      )}

      {room?.status === "playing" && (
        <OnlineRoomGame
          room={room}
          names={names}
          userId={user.id}
          onRefreshRoom={refreshRoom}
          onNotice={setRoomNotice}
        />
      )}

      {roomNotice && <p className="accountRoom__notice" role="status">{roomNotice}</p>}
          </>
        )}
        <PanelStyles />
      </aside>
      <AccountAuthDialog
        open={authOpen}
        busy={authBusy}
        error={authError}
        notice={authNotice}
        onClose={() => setAuthOpen(false)}
        onSubmit={handleAuth}
      />
      {user && (
        <HitLedgerDialog
          open={ledgerOpen}
          busy={ledgerBusy}
          error={ledgerError}
          userId={user.id}
          profile={profile}
          names={names}
          obligations={obligations}
          onClose={() => setLedgerOpen(false)}
          onRecordHit={recordHit}
        />
      )}
    </>
  );
}

function PanelStyles() {
  return <style jsx global>{`
    .accountRoom{color:#f6ead2;background:linear-gradient(150deg,rgba(28,40,37,.97),rgba(13,20,20,.98));border:1px solid rgba(221,180,106,.28);border-radius:22px;padding:20px;box-shadow:0 24px 80px rgba(0,0,0,.32);font-family:var(--font-sans,Arial,sans-serif)}
    .accountRoom--empty{display:flex;gap:10px;flex-direction:column}.accountRoom--empty span{color:#aaafa8;font-size:13px}
    .accountRoom__header,.accountRoom__roomTitle,.auth-dialog>header{display:flex;align-items:center;justify-content:space-between;gap:14px}.accountRoom small,.auth-dialog small{display:block;color:#d5a65e;font-size:10px;font-weight:800;letter-spacing:.18em}.accountRoom h2,.accountRoom h3,.auth-dialog h2{margin:3px 0 0}.accountRoom h2,.auth-dialog h2{font-size:20px}.accountRoom h3{font-size:17px}
    .accountRoom button,.accountRoom input,.accountRoom select,.auth-dialog button,.auth-dialog input,.auth-dialog select{font:inherit}.accountRoom button,.auth-dialog button{cursor:pointer}.accountRoom button:disabled,.auth-dialog button:disabled{cursor:not-allowed;opacity:.46}
    .accountRoom__tabs{display:flex;padding:3px;background:#0c1413;border-radius:10px}.accountRoom__tabs button{border:0;background:transparent;color:#929b96;padding:7px 9px;border-radius:7px;font-size:12px}.accountRoom__tabs button[aria-selected=true]{background:#2a3c36;color:#fff}
    .accountRoom__auth{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:16px}.accountRoom__auth label:first-child:nth-last-child(4){grid-column:1/-1}.accountRoom label,.auth-dialog label{color:#b8c0bb;font-size:11px;font-weight:700}.accountRoom input,.accountRoom select,.auth-dialog input,.auth-dialog select{width:100%;box-sizing:border-box;margin-top:5px;padding:10px 11px;color:#f8eedb;background:#101b19;border:1px solid #34443f;border-radius:10px;outline:none}.accountRoom input:focus,.accountRoom select:focus,.auth-dialog input:focus,.auth-dialog select:focus{border-color:#d7a95e;box-shadow:0 0 0 3px rgba(215,169,94,.12)}
    .accountRoom__primary,.accountRoom__ghost,.accountRoom__ready{border-radius:10px;padding:10px 13px;font-weight:800}.accountRoom__primary{border:1px solid #e1b56b;background:linear-gradient(#e1b56b,#b97a32);color:#20170d}.accountRoom__ghost{border:1px solid #465650;background:transparent;color:#cbd2ce}.accountRoom__ready{border:1px solid #52635d;background:#20302c;color:#c8d1cc}.accountRoom__ready.is-ready{border-color:#65c6a0;background:#174636;color:#bff4dc}
    .accountRoom__headerActions{display:flex;align-items:center;gap:7px}.accountRoom__ledgerTrigger{min-height:44px;padding:9px 12px;border:1px solid #9b713b;border-radius:10px;background:#2e2419;color:#f0cc91;font-size:11px;font-weight:800;white-space:nowrap}
    .accountRoom__stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:15px 0}.accountRoom__stats span{padding:9px 5px;text-align:center;background:#101a18;border-radius:9px;color:#929b96;font-size:10px}.accountRoom__stats b{display:block;color:#f2d7a7;font-size:15px}
    .accountRoom__lobby,.accountRoom__room{padding-top:15px;margin-top:15px;border-top:1px solid rgba(221,180,106,.17)}.accountRoom__create{display:grid;grid-template-columns:110px 1fr;gap:8px;margin-top:12px;align-items:end}.accountRoom__join{display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:10px}.accountRoom__join label{grid-column:1/-1}.accountRoom__join input{margin:0;text-transform:uppercase;letter-spacing:.16em;font-weight:900}
    .accountRoom__status{padding:6px 9px;border-radius:999px;background:#263631;color:#bfcac4;font-size:11px;font-weight:800}.accountRoom__status--playing{background:#553118;color:#ffc57e}
    .accountRoom__roster{list-style:none;padding:0;margin:12px 0;display:grid;grid-template-columns:repeat(2,1fr);gap:7px}.accountRoom__roster li{display:grid;grid-template-columns:25px 1fr;align-items:center;padding:9px;background:#101918;border:1px dashed #384641;border-radius:10px;color:#69726e}.accountRoom__roster li>span{grid-row:1/3;display:grid;place-items:center;width:20px;height:20px;border-radius:6px;background:#26312e;font-size:10px}.accountRoom__roster li b{font-size:12px}.accountRoom__roster li em{font-style:normal;font-size:9px;color:#7d8a85}.accountRoom__roster li.is-filled{border-style:solid;color:#eef1ed}.accountRoom__roster li.is-filled>span{background:#91642e;color:#fff}.accountRoom__actions{display:flex;flex-wrap:wrap;gap:7px}.accountRoom__actions button{flex:1}
    .accountRoom__notice{margin:12px 0 0;padding:9px 11px;border-left:3px solid #d7a95e;background:#2a251c;color:#ead7b8;font-size:12px}
    @media(max-width:520px){.accountRoom{padding:16px}.accountRoom__header{align-items:flex-start;flex-direction:column}.accountRoom__headerActions{width:100%}.accountRoom__headerActions button{flex:1;min-height:44px}.accountRoom__auth{grid-template-columns:1fr}.accountRoom__auth>*{grid-column:1}.accountRoom__stats{grid-template-columns:repeat(2,1fr)}.accountRoom__roster{grid-template-columns:1fr}}
  `}</style>;
}
