const ROOM_KEY = "pulseplay-room-2468";
const ACTIVITIES_KEY = "pulseplay-activities";
const USERS_KEY = "pulseplay-admin-users";
const ADMIN_SESSION_KEY = "pulseplay-admin-session";
const CLIENT_KEY = "pulseplay-client-id";
const channel = "BroadcastChannel" in window ? new BroadcastChannel("pulseplay-live") : null;

const starterQuestions = [
  { id: crypto.randomUUID(), type: "quiz", title: "¿Qué planeta es conocido como el planeta rojo?", options: ["Venus", "Marte", "Júpiter", "Mercurio"], correct: 1, duration: 20 },
  { id: crypto.randomUUID(), type: "quiz", title: "¿Cuál de estos lenguajes se ejecuta directamente en el navegador?", options: ["Python", "Java", "JavaScript", "C#"], correct: 2, duration: 20 },
  { id: crypto.randomUUID(), type: "wordcloud", title: "En una palabra, ¿qué hace memorable una buena presentación?", duration: 30 },
];

const defaultActivity = () => ({ id: "demo", ownerId: "admin-demo", workspaceId: "admin-demo", title: "Demo interactiva", description: "Trivia y participación en vivo", status: "draft", updatedAt: Date.now(), questions: starterQuestions });
const defaultUsers = () => [{ id: "admin-demo", workspaceId: "admin-demo", name: "Admin Demo", email: "admin@pulseplay.local", password: "demo123", role: "owner", createdAt: Date.now() }];
const defaultRoom = () => ({ code: "", activityId: "demo", status: "lobby", index: 0, reveal: false, startedAt: null, endsAt: null, participants: [], blockedParticipants: [], answers: {}, words: [], version: 1 });

let route = location.hash.replace("#", "") || "/";
let timerHandle = null;
let toastHandle = null;
let editorDirty = false;
let libraryState = { query: "", sort: "recent", page: 1, pageSize: 10 };
let resultsState = { query: "", sort: "recent", status: "all", page: 1, pageSize: 10 };
let localPlayer = readJson(sessionStorage.getItem("pulseplay-player"), null);
let supabaseAdmin = null;
let authReady = false;
let activitiesReady = false;
let liveRoomCache = null;
let liveSyncHandle = null;
let sessionHistory = [];
let historyReady = false;
let workspaceUsers = [];
let workspaceInvitations = [];
let usersReady = false;
let platformUsers = [];
let platformUsersReady = false;
let authProviders = { email: true, google: false, ready: false };
const LIVE_CODE_KEY = "pulseplay-live-code";
const clientId = sessionStorage.getItem(CLIENT_KEY) || crypto.randomUUID();
sessionStorage.setItem(CLIENT_KEY, clientId);

function readJson(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function getActivities() {
  return readJson(localStorage.getItem(ACTIVITIES_KEY), [defaultActivity()]).map(activity => ({
    ...activity,
    ownerId: activity.ownerId || "admin-demo",
    workspaceId: activity.workspaceId || activity.ownerId || "admin-demo",
    questions: (activity.questions || []).map((question, index) => ({ ...question, id: question.id || `${activity.id}-q-${index}` })),
  }));
}
function saveActivities(items) { localStorage.setItem(ACTIVITIES_KEY, JSON.stringify(items)); }
function getOwnedActivities() { const admin = getAdmin(); return admin ? getActivities().filter(activity => activity.workspaceId === (admin.workspaceId || admin.id)) : []; }
function getUsers() { return readJson(localStorage.getItem(USERS_KEY), defaultUsers()).map(user => ({ ...user, workspaceId: user.workspaceId || user.invitedBy || user.id })); }
function saveUsers(items) { localStorage.setItem(USERS_KEY, JSON.stringify(items)); }
function getAdmin() {
  if (window.isSupabaseConfigured?.()) return supabaseAdmin;
  const id = localStorage.getItem(ADMIN_SESSION_KEY) || sessionStorage.getItem(ADMIN_SESSION_KEY);
  return getUsers().find(user => user.id === id) || null;
}

function authRedirect(path = "") {
  const configured = window.PULSEPLAY_CONFIG?.publicAppUrl || `${location.origin}${location.pathname}`;
  const base = configured.endsWith("/") ? configured : `${configured}/`;
  return `${base}${path.replace(/^\//, "")}`;
}

async function loadAuthProviderSettings() {
  const config = window.PULSEPLAY_CONFIG;
  if (!config?.supabaseUrl || !config?.supabaseAnonKey) return;
  try {
    const response = await fetch(`${config.supabaseUrl}/auth/v1/settings`, {
      headers: { apikey: config.supabaseAnonKey },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const settings = await response.json();
    authProviders = {
      email: settings.external?.email !== false,
      google: settings.external?.google === true,
      ready: true,
    };
  } catch (error) {
    console.warn("No se pudo consultar la configuración de proveedores", error);
    authProviders = { ...authProviders, ready: true };
  }
}

async function loadSupabaseAdmin(user) {
  if (!user || !window.pulseplaySupabase) {
    supabaseAdmin = null;
    activitiesReady = false;
    workspaceUsers = [];
    workspaceInvitations = [];
    usersReady = false;
    return;
  }

  const [{ data: profile }, { data: membership }] = await Promise.all([
    window.pulseplaySupabase.from("profiles").select("name, created_at, platform_role, account_status").eq("id", user.id).maybeSingle(),
    window.pulseplaySupabase.from("workspace_members").select("workspace_id, role").eq("user_id", user.id).limit(1).maybeSingle(),
  ]);

  if (profile?.account_status === "suspended") {
    supabaseAdmin = null;
    await window.pulseplaySupabase.auth.signOut();
    return;
  }

  supabaseAdmin = {
    id: user.id,
    workspaceId: membership?.workspace_id || user.id,
    name: profile?.name || user.user_metadata?.full_name || user.email?.split("@")[0] || "Administrador",
    email: user.email || "",
    role: membership?.role || "owner",
    createdAt: profile?.created_at ? new Date(profile.created_at).getTime() : Date.now(),
    provider: user.app_metadata?.provider || "email",
    platformRole: profile?.platform_role || "user",
    accountStatus: profile?.account_status || "active",
  };
  await Promise.all([loadSupabaseActivities(), loadSessionHistory(), loadWorkspaceUsers(), loadPlatformUsers()]);
}

async function loadPlatformUsers() {
  platformUsers = [];
  platformUsersReady = false;
  if (!window.pulseplaySupabase || supabaseAdmin?.platformRole !== "super_admin") return;
  try {
    const { data, error } = await window.pulseplaySupabase.functions.invoke("manage-platform-users", {
      body: { action: "list" },
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    platformUsers = data?.users || [];
  } catch (error) {
    console.warn("No se pudo cargar la administración de usuarios", error);
  }
  platformUsersReady = true;
}

async function managePlatformUser(action, userId, extra = {}) {
  try {
    const { data, error } = await window.pulseplaySupabase.functions.invoke("manage-platform-users", {
      body: { action, userId, ...extra },
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    await loadPlatformUsers();
    render();
    showToast(data?.message || "Cuenta actualizada");
  } catch (error) {
    showToast(error.message || "No se pudo administrar la cuenta");
  }
}

async function loadWorkspaceUsers() {
  if (!window.pulseplaySupabase || !supabaseAdmin?.workspaceId) return;
  const { data: memberships, error: membersError } = await window.pulseplaySupabase
    .from("workspace_members")
    .select("user_id, role, created_at, profiles!workspace_members_user_id_fkey(name, email, avatar_url)")
    .eq("workspace_id", supabaseAdmin.workspaceId)
    .order("created_at", { ascending: true });
  if (membersError) {
    console.warn("La gestión de equipo todavía no está disponible", membersError);
    workspaceUsers = [{ ...supabaseAdmin }];
    workspaceInvitations = [];
    usersReady = true;
    return;
  }

  workspaceUsers = (memberships || []).map(membership => {
    const profile = Array.isArray(membership.profiles) ? membership.profiles[0] : membership.profiles;
    return {
      id: membership.user_id,
      name: profile?.name || profile?.email?.split("@")[0] || "Usuario",
      email: profile?.email || "",
      role: membership.role,
      createdAt: membership.created_at,
    };
  });

  workspaceInvitations = [];
  if (supabaseAdmin) {
    const { data: invitations, error: invitationsError } = await window.pulseplaySupabase
      .from("workspace_invitations")
      .select("id, email, role, status, created_at")
      .eq("workspace_id", supabaseAdmin.workspaceId)
      .eq("status", "pending")
      .order("created_at", { ascending: false });
    if (invitationsError) console.warn("No se pudieron cargar las invitaciones", invitationsError);
    else workspaceInvitations = invitations || [];
  }
  usersReady = true;
}

async function loadSessionHistory() {
  if (!window.pulseplaySupabase || !supabaseAdmin?.workspaceId) return;
  const { data: sessions, error: sessionsError } = await window.pulseplaySupabase
    .from("live_sessions")
    .select("id, activity_id, code, status, created_at, started_at, ended_at")
    .eq("workspace_id", supabaseAdmin.workspaceId)
    .order("created_at", { ascending: false });
  if (sessionsError) throw sessionsError;

  const sessionIds = (sessions || []).map(session => session.id);
  const activityIds = [...new Set((sessions || []).map(session => session.activity_id).filter(Boolean))];
  const [participantsResult, responsesResult, questionsResult] = await Promise.all([
    sessionIds.length ? window.pulseplaySupabase.from("participants").select("id, session_id, display_name, score, joined_at").in("session_id", sessionIds) : Promise.resolve({ data: [], error: null }),
    sessionIds.length ? window.pulseplaySupabase.from("responses").select("id, session_id, question_id, participant_id, payload, is_correct, points, submitted_at, question_title, question_type, question_options").in("session_id", sessionIds) : Promise.resolve({ data: [], error: null }),
    activityIds.length ? window.pulseplaySupabase.from("questions").select("id, activity_id, position, type, title, options, correct_option, settings").in("activity_id", activityIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (participantsResult.error) throw participantsResult.error;
  if (responsesResult.error) throw responsesResult.error;
  if (questionsResult.error) throw questionsResult.error;

  sessionHistory = (sessions || []).map(session => ({
    ...session,
    participants: (participantsResult.data || []).filter(item => item.session_id === session.id),
    responses: (responsesResult.data || []).filter(item => item.session_id === session.id),
    questions: (questionsResult.data || []).filter(item => item.activity_id === session.activity_id).sort((a, b) => a.position - b.position),
  }));
  historyReady = true;
}

function databaseQuestionToLocal(question) {
  const settings = question.settings || {};
  return {
    id: question.id,
    type: question.type,
    title: question.title,
    options: question.options || [],
    correct: question.correct_option,
    duration: question.duration_seconds || 0,
    scaleMax: settings.scaleMax,
    minLabel: settings.minLabel,
    maxLabel: settings.maxLabel,
  };
}

function databaseActivityToLocal(activity) {
  return {
    id: activity.id,
    ownerId: activity.created_by,
    workspaceId: activity.workspace_id,
    title: activity.title,
    description: activity.description || "",
    status: activity.status,
    updatedAt: new Date(activity.updated_at).getTime(),
    questions: (activity.questions || []).sort((a, b) => a.position - b.position).map(databaseQuestionToLocal),
  };
}

async function loadSupabaseActivities() {
  if (!window.pulseplaySupabase || !supabaseAdmin?.workspaceId) return;
  const { data, error } = await window.pulseplaySupabase
    .from("activities")
    .select("id, workspace_id, created_by, title, description, status, updated_at, questions(id, type, position, title, options, correct_option, duration_seconds, settings)")
    .eq("workspace_id", supabaseAdmin.workspaceId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  const otherWorkspaces = getActivities().filter(activity => activity.workspaceId !== supabaseAdmin.workspaceId);
  saveActivities([...otherWorkspaces, ...(data || []).map(databaseActivityToLocal)]);
  activitiesReady = true;
}

function localQuestionToDatabase(question) {
  return {
    id: question.id,
    type: question.type,
    title: question.title,
    options: question.options || [],
    correct_option: question.type === "quiz" ? question.correct : null,
    duration_seconds: question.duration || null,
    settings: question.type === "scale" ? {
      scaleMax: question.scaleMax || 5,
      minLabel: question.minLabel || "Nada",
      maxLabel: question.maxLabel || "Mucho",
    } : {},
  };
}

async function persistActivity(activity) {
  saveActivities(getActivities().map(item => item.id === activity.id ? activity : item));
  if (!window.pulseplaySupabase || !supabaseAdmin) return;

  const { error: activityError } = await window.pulseplaySupabase
    .from("activities")
    .update({
      title: activity.title,
      description: activity.description || "",
      status: activity.status || "draft",
    })
    .eq("id", activity.id);
  if (activityError) throw activityError;

  const { error: deleteError } = await window.pulseplaySupabase
    .from("questions")
    .delete()
    .eq("activity_id", activity.id);
  if (deleteError) throw deleteError;

  if (activity.questions.length) {
    const questions = activity.questions.map((question, position) => {
      const databaseQuestion = localQuestionToDatabase(question);
      return {
        id: databaseQuestion.id,
        activity_id: activity.id,
        type: databaseQuestion.type,
        position,
        title: databaseQuestion.title,
        options: databaseQuestion.options,
        correct_option: databaseQuestion.correct_option,
        duration_seconds: databaseQuestion.duration_seconds,
        settings: databaseQuestion.settings,
      };
    });
    const { error: questionsError } = await window.pulseplaySupabase.from("questions").insert(questions);
    if (questionsError) throw questionsError;
  }
  await loadSupabaseActivities();
}

async function initializeAuth() {
  if (window.supabaseConfigurationError) {
    authReady = true;
    throw new Error(window.supabaseConfigurationError);
  }
  if (!window.pulseplaySupabase) {
    authReady = true;
    return;
  }

  await loadAuthProviderSettings();
  const { data } = await window.pulseplaySupabase.auth.getSession();
  await loadSupabaseAdmin(data.session?.user || null);
  const returnedFromInvite = window.pulseplayAuthReturn?.invited || window.pulseplayAuthReturn?.type === "invite";
  const returnedFromOAuth = window.pulseplayAuthReturn?.oauth;
  const returnedFromConfirmation = window.pulseplayAuthReturn?.confirmed || window.pulseplayAuthReturn?.type === "signup";
  if (data.session && returnedFromInvite) {
    authReady = true;
    navigate("/reset-password");
  } else if (data.session && returnedFromConfirmation) {
    authReady = true;
    navigate("/confirmed");
  } else if (data.session && returnedFromOAuth) {
    authReady = true;
    window.pulseplayAuthReturn.oauth = false;
    history.replaceState(null, "", `${location.pathname}#/dashboard`);
    route = "/dashboard";
  }
  window.pulseplaySupabase.auth.onAuthStateChange((event, session) => {
    setTimeout(async () => {
      await loadSupabaseAdmin(session?.user || null);
      authReady = true;
      const currentRoute = location.hash.replace("#", "") || "/";
      if (event === "PASSWORD_RECOVERY" || (session && (window.pulseplayAuthReturn?.invited || window.pulseplayAuthReturn?.type === "invite"))) navigate("/reset-password");
      else if (session && (window.pulseplayAuthReturn?.confirmed || window.pulseplayAuthReturn?.type === "signup")) navigate("/confirmed");
      else if (session && (window.pulseplayAuthReturn?.oauth || ["/", "/login", "/register"].includes(currentRoute) || currentRoute.includes("access_token="))) {
        window.pulseplayAuthReturn.oauth = false;
        history.replaceState(null, "", `${location.pathname}#/dashboard`);
        route = "/dashboard";
      }
      render();
    }, 0);
  });
  authReady = true;
}
function getRoom() { return liveRoomCache || { ...defaultRoom(), ...readJson(localStorage.getItem(ROOM_KEY), {}) }; }
function getActivity(id = getRoom().activityId) { return getActivities().find(item => item.id === id) || getActivities()[0]; }
function getOwnedActivity(id) { const admin = getAdmin(); return getActivities().find(item => item.id === id && item.workspaceId === (admin?.workspaceId || admin?.id)); }
function getQuestions(room = getRoom()) { return room.questions?.length ? room.questions : getActivity(room.activityId)?.questions || []; }

function saveRoom(next) {
  next.version = (next.version || 0) + 1;
  localStorage.setItem(ROOM_KEY, JSON.stringify(next));
  channel?.postMessage({ type: "room-update", version: next.version });
  render();
}

function mutateRoom(fn) { const room = getRoom(); fn(room); saveRoom(room); }
function navigate(path) { location.hash = path; }
function createRoomCode() { return String(crypto.getRandomValues(new Uint32Array(1))[0] % 9000 + 1000); }
function roomForActivity(activityId) { return { ...defaultRoom(), code: createRoomCode(), activityId }; }

function setLiveRoom(room) {
  if (!room) return null;
  liveRoomCache = { ...defaultRoom(), ...room, startedAt: Number(room.startedAt) || null, endsAt: Number(room.endsAt) || null };
  sessionStorage.setItem(LIVE_CODE_KEY, liveRoomCache.code);
  if (room.player) {
    localPlayer = room.player;
    sessionStorage.setItem("pulseplay-player", JSON.stringify(localPlayer));
  }
  return liveRoomCache;
}

async function fetchLiveRoom(shouldRender = true) {
  if (!window.pulseplaySupabase) return null;
  const code = liveRoomCache?.code || sessionStorage.getItem(LIVE_CODE_KEY);
  if (!code) return null;
  const { data, error } = await window.pulseplaySupabase.rpc("pulseplay_live_state", {
    p_code: code,
    p_client_id: localPlayer?.clientId || clientId,
  });
  if (error || !data) return null;
  const previous = JSON.stringify(liveRoomCache);
  setLiveRoom(data);
  if (shouldRender && previous !== JSON.stringify(liveRoomCache)) render();
  return liveRoomCache;
}

async function createLiveSession(activityId) {
  if (!window.pulseplaySupabase) {
    saveRoom(roomForActivity(activityId));
    return getRoom();
  }
  const { data, error } = await window.pulseplaySupabase.rpc("pulseplay_create_live_session", { p_activity_id: activityId });
  if (error) throw error;
  return setLiveRoom(data);
}

async function joinLiveSession(code, name) {
  if (!window.pulseplaySupabase) return null;
  const { data, error } = await window.pulseplaySupabase.rpc("pulseplay_join_live_session", {
    p_code: code,
    p_client_id: clientId,
    p_display_name: name,
  });
  if (error) throw error;
  return setLiveRoom(data);
}

async function submitLiveResponse(payload) {
  const room = getRoom();
  const { data, error } = await window.pulseplaySupabase.rpc("pulseplay_submit_response", {
    p_code: room.code,
    p_client_id: localPlayer?.clientId || clientId,
    p_payload: payload,
  });
  if (error) throw error;
  setLiveRoom(data);
  render();
}

async function controlLiveSession(action, participantId = null) {
  const room = getRoom();
  const { data, error } = await window.pulseplaySupabase.rpc("pulseplay_control_live_session", {
    p_session_id: room.id,
    p_action: action,
    p_participant_id: participantId,
  });
  if (error) throw error;
  setLiveRoom(data);
  render();
}

function showToast(message) {
  document.querySelector(".toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  clearTimeout(toastHandle);
  toastHandle = setTimeout(() => toast.remove(), 2400);
}

function shell(content, actions = "") {
  return `<div class="shell"><header class="topbar"><button class="admin-link brand" data-nav="${getAdmin() ? "/dashboard" : "/"}"><span class="brand-mark">P</span> PulsePlay</button><div class="top-actions">${actions}</div></header>${content}</div>`;
}

function adminShell(content, active = "dashboard") {
  const admin = getAdmin();
  const liveRoom = getRoom();
  const hasActiveSession = Boolean(liveRoom.code) && liveRoom.status !== "finished";
  return shell(`<main class="admin-layout">
    <aside class="panel admin-sidebar">
      <div><div class="eyebrow">Espacio de trabajo</div><h3>PulsePlay Studio</h3></div>
      <nav class="admin-nav">
        <button class="${active === "dashboard" ? "active" : ""}" data-nav="/dashboard">Actividades</button>
        <button class="${active === "results" ? "active" : ""}" data-nav="/results">Resultados</button>
        <button class="${active === "users" ? "active" : ""}" data-nav="/users">${admin?.platformRole === "super_admin" ? "Administración" : "Equipo"}</button>
        <button class="${active === "profile" ? "active" : ""}" data-nav="/profile">Mi perfil</button>
        ${hasActiveSession ? `<button class="live-session-link" data-nav="/admin"><span class="status-dot"></span>Sesión activa</button>` : ""}
      </nav>
      <button class="admin-profile" data-nav="/profile"><span class="avatar">${escapeHtml(admin?.name?.[0] || "A")}</span><span><strong>${escapeHtml(admin?.name || "Admin")}</strong><small>${admin?.email || ""}</small></span></button>
    </aside>
    <section class="admin-content">${content}</section>
  </main>`, `<button class="admin-link" id="admin-logout">Cerrar sesión</button>`);
}

function homeView() {
  return shell(`<main class="home">
    <section class="hero"><div class="eyebrow">Experiencias que conectan</div><h1>Haz que todos <span class="gradient-text">participen.</span></h1><p>Preguntas, encuestas y nubes de palabras en vivo. Tu audiencia responde desde el teléfono y tú diriges la experiencia.</p><div class="chips"><span class="chip">Quiz en vivo</span><span class="chip">Nube de palabras</span><span class="chip">Leaderboard</span></div></section>
    <section class="panel join-panel"><div class="eyebrow">Entrar a una sesión</div><h2>¡Vamos a jugar!</h2><p class="muted">Usa el código que aparece en pantalla.</p><form id="join-form"><div class="field"><label>Código de sala</label><input class="code-input" name="code" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" placeholder="0000" required /></div><div class="field"><label>Tu nombre</label><input name="name" maxlength="20" placeholder="Ej. Sofía" required /></div><button class="btn full" type="submit">Entrar a la sala</button></form><button class="admin-link full" style="margin-top:16px" data-nav="/login">Administrar actividades →</button></section>
  </main>`);
}

function confirmedView() {
  const admin = getAdmin();
  return shell(`<main class="auth-wrap"><section class="panel auth-card confirmation-card"><div class="waiting-orb confirmation-check">✓</div><div class="eyebrow">Cuenta confirmada</div><h1>¡Ya quedaste registrado!</h1><p class="muted">Tu correo fue verificado correctamente y tu espacio de PulsePlay está listo.</p><button class="btn full" data-nav="${admin ? "/dashboard" : "/login"}">${admin ? "Ir a mis actividades" : "Iniciar sesión"}</button></section></main>`);
}

function loginView() {
  if (getAdmin()) { navigate("/dashboard"); return ""; }
  return shell(`<main class="auth-wrap"><section class="panel auth-card"><div class="eyebrow">Acceso administrador</div><h1>Bienvenido de vuelta</h1><p class="muted">Gestiona tus actividades y sesiones en vivo.</p>${googleAuthButton()}<div class="auth-divider"><span>o continúa con correo</span></div><form id="login-form"><div class="field"><label>Correo</label><input name="email" type="email" autocomplete="email" required /></div><div class="field"><label>Contraseña</label><input name="password" type="password" autocomplete="current-password" required /></div><div class="auth-form-links"><label><input type="checkbox" name="remember" checked /> Mantener sesión iniciada</label><button type="button" class="admin-link" data-nav="/forgot">¿Olvidaste tu contraseña?</button></div><button class="btn full">Iniciar sesión</button></form><p class="auth-switch">¿No tienes una cuenta? <button class="admin-link" data-nav="/register">Crear cuenta</button></p></section></main>`, `<button class="admin-link" data-nav="/">Volver</button>`);
}

function googleAuthButton() {
  if (!window.isSupabaseConfigured?.()) return "";
  const enabled = authProviders.google;
  return `<button class="google-auth ${enabled ? "" : "provider-disabled"}" type="button" id="google-auth" ${enabled ? "" : "disabled"}><span>G</span>${enabled ? "Continuar con Google" : "Google aún no disponible"}<small>${enabled ? "Inicia sesión o crea tu cuenta" : "El proveedor debe activarse en Supabase"}</small></button>`;
}

function registerView() {
  if (getAdmin()) { navigate("/dashboard"); return ""; }
  return shell(`<main class="auth-wrap"><section class="panel auth-card"><div class="eyebrow">Nueva cuenta</div><h1>Crea tu espacio</h1><p class="muted">Tu biblioteca quedará separada de las demás cuentas.</p>${googleAuthButton()}<div class="auth-divider"><span>o regístrate con correo</span></div><form id="register-form"><div class="field"><label>Nombre</label><input name="name" autocomplete="name" maxlength="60" required /></div><div class="field"><label>Correo</label><input name="email" type="email" autocomplete="email" required /></div><div class="field"><label>Contraseña</label><input name="password" type="password" autocomplete="new-password" minlength="8" required /></div><div class="field"><label>Confirmar contraseña</label><input name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required /></div><label class="terms-check"><input type="checkbox" required /> Acepto los términos y la política de privacidad</label><button class="btn full">Crear cuenta</button></form><p class="auth-switch">¿Ya tienes cuenta? <button class="admin-link" data-nav="/login">Iniciar sesión</button></p></section></main>`, `<button class="admin-link" data-nav="/">Volver</button>`);
}

function forgotView() {
  return shell(`<main class="auth-wrap"><section class="panel auth-card"><div class="eyebrow">Recuperar acceso</div><h1>Restablece tu contraseña</h1><p class="muted">${window.isSupabaseConfigured?.() ? "Te enviaremos un enlace seguro por correo." : "En este MVP local podrás cambiarla en el siguiente paso."}</p><form id="forgot-form"><div class="field"><label>Correo de la cuenta</label><input name="email" type="email" autocomplete="email" required /></div><button class="btn full">Continuar</button></form><p class="auth-switch"><button class="admin-link" data-nav="/login">← Volver al inicio de sesión</button></p></section></main>`);
}

function resetView(email) {
  return shell(`<main class="auth-wrap"><section class="panel auth-card"><div class="eyebrow">Recuperación local</div><h1>Nueva contraseña</h1><p class="muted">Cuenta: ${escapeHtml(email)}</p><form id="reset-form" data-email="${escapeAttr(email)}"><div class="field"><label>Nueva contraseña</label><input name="password" type="password" minlength="8" required /></div><div class="field"><label>Confirmar contraseña</label><input name="confirmPassword" type="password" minlength="8" required /></div><button class="btn full">Actualizar contraseña</button></form></section></main>`);
}

function dashboardView() {
  const activities = getOwnedActivities();
  return adminShell(`<div class="admin-heading"><div><div class="eyebrow">Biblioteca</div><h1>Mis actividades</h1><p class="muted">Crea contenido y déjalo listo para una sesión en vivo.</p></div><button class="btn" id="new-activity">+ Nueva actividad</button></div><div class="library-toolbar"><label class="library-search"><span>⌕</span><input id="activity-search" value="${escapeAttr(libraryState.query)}" placeholder="Buscar por nombre o descripción…" /></label><label class="sort-control"><span>Ordenar por</span><select id="activity-sort"><option value="recent" ${libraryState.sort === "recent" ? "selected" : ""}>Más recientes primero</option><option value="oldest" ${libraryState.sort === "oldest" ? "selected" : ""}>Más antiguas primero</option><option value="name" ${libraryState.sort === "name" ? "selected" : ""}>Nombre A–Z</option><option value="name-desc" ${libraryState.sort === "name-desc" ? "selected" : ""}>Nombre Z–A</option></select></label></div><div id="library-results">${libraryResultsMarkup(activities)}</div>`, "dashboard");
}

function sessionActivityTitle(session) {
  return getOwnedActivities().find(activity => activity.id === session.activity_id)?.title || "Actividad eliminada";
}

function sessionStatusLabel(status) {
  return ({ lobby: "En espera", question: "En curso", results: "Resultados", leaderboard: "Leaderboard", finished: "Finalizada" })[status] || status;
}

function resultsView() {
  if (!historyReady) return adminShell(`<section class="panel results-empty"><h2>Cargando resultados...</h2></section>`, "results");
  return adminShell(`<div class="admin-heading"><div><div class="eyebrow">Historial</div><h1>Resultados</h1><p class="muted">Revisa la participación y las respuestas de tus sesiones anteriores.</p></div><button class="btn secondary" id="refresh-results">Actualizar</button></div><div class="results-toolbar"><label class="library-search"><span>⌕</span><input id="results-search" value="${escapeAttr(resultsState.query)}" placeholder="Buscar por actividad o código de sala…" /></label><label class="sort-control"><span>Estado</span><select id="results-status"><option value="all" ${resultsState.status === "all" ? "selected" : ""}>Todos</option><option value="finished" ${resultsState.status === "finished" ? "selected" : ""}>Finalizadas</option><option value="active" ${resultsState.status === "active" ? "selected" : ""}>En curso</option></select></label><label class="sort-control"><span>Ordenar por</span><select id="results-sort"><option value="recent" ${resultsState.sort === "recent" ? "selected" : ""}>Más recientes primero</option><option value="oldest" ${resultsState.sort === "oldest" ? "selected" : ""}>Más antiguas primero</option><option value="participants" ${resultsState.sort === "participants" ? "selected" : ""}>Más participantes</option><option value="responses" ${resultsState.sort === "responses" ? "selected" : ""}>Más respuestas</option><option value="name" ${resultsState.sort === "name" ? "selected" : ""}>Actividad A–Z</option></select></label></div><div id="results-list">${resultsListMarkup()}</div>`, "results");
}

function resultsListMarkup() {
  const query = resultsState.query.trim().toLowerCase();
  const filtered = sessionHistory.filter(session => {
    const matchesQuery = `${sessionActivityTitle(session)} ${session.code}`.toLowerCase().includes(query);
    const matchesStatus = resultsState.status === "all" || (resultsState.status === "finished" ? session.status === "finished" : session.status !== "finished");
    return matchesQuery && matchesStatus;
  });
  filtered.sort((a, b) => resultsState.sort === "oldest"
    ? new Date(a.created_at) - new Date(b.created_at)
    : resultsState.sort === "participants"
      ? b.participants.length - a.participants.length
      : resultsState.sort === "responses"
        ? b.responses.length - a.responses.length
        : resultsState.sort === "name"
          ? sessionActivityTitle(a).localeCompare(sessionActivityTitle(b), "es")
          : new Date(b.created_at) - new Date(a.created_at));
  const totalPages = Math.max(1, Math.ceil(filtered.length / resultsState.pageSize));
  resultsState.page = Math.min(resultsState.page, totalPages);
  const start = (resultsState.page - 1) * resultsState.pageSize;
  const pageItems = filtered.slice(start, start + resultsState.pageSize);
  const rows = pageItems.map(session => `<article class="history-row">
    <div><strong>${escapeHtml(sessionActivityTitle(session))}</strong><small>Sala ${escapeHtml(session.code)} · ${formatDate(new Date(session.created_at).getTime())}</small></div>
    <span class="activity-status">${sessionStatusLabel(session.status)}</span>
    <span><b>${session.participants.length}</b> participantes</span>
    <span><b>${session.responses.length}</b> respuestas</span>
    <button class="btn secondary" data-nav="/results/${session.id}">Ver detalle</button>
  </article>`).join("");
  const from = filtered.length ? start + 1 : 0;
  const to = Math.min(start + resultsState.pageSize, filtered.length);
  return `<section class="panel history-list">${rows || `<div class="results-empty"><strong>No encontramos resultados</strong><span class="muted">Prueba con otros filtros o presenta una actividad.</span></div>`}</section><div class="pagination-bar"><span>Mostrando ${from}–${to} de ${filtered.length}</span><label>Filas por página <select id="results-page-size"><option value="10" ${resultsState.pageSize === 10 ? "selected" : ""}>10</option><option value="25" ${resultsState.pageSize === 25 ? "selected" : ""}>25</option><option value="50" ${resultsState.pageSize === 50 ? "selected" : ""}>50</option></select></label><div class="page-controls"><button id="results-prev" ${resultsState.page === 1 ? "disabled" : ""}>←</button><strong>Página ${resultsState.page} de ${totalPages}</strong><button id="results-next" ${resultsState.page === totalPages ? "disabled" : ""}>→</button></div></div>`;
}

function responseValue(response, question) {
  const payload = response.payload || {};
  const options = question?.options || response.question_options || [];
  if (Array.isArray(payload.ranking)) return payload.ranking.map(index => options[index] || `Opción ${index + 1}`).join(" > ");
  if (payload.option !== undefined) return options[payload.option] || `Opción ${Number(payload.option) + 1}`;
  if (payload.value !== undefined) return String(payload.value);
  return payload.text || payload.word || "Sin contenido";
}

function sessionResultsView(sessionId) {
  const session = sessionHistory.find(item => item.id === sessionId);
  if (!session) return resultsView();
  const participantMap = new Map(session.participants.map(item => [item.id, item]));
  const questionMap = new Map(session.questions.map(item => [item.id, item]));
  const grouped = new Map();
  session.responses.forEach(response => {
    const key = response.question_id || `${response.question_type}:${response.question_title}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(response);
  });
  const questions = [...grouped.entries()].map(([questionId, responses]) => {
    const first = responses[0];
    const question = questionMap.get(questionId) || { title: first.question_title || "Pregunta", type: first.question_type, options: first.question_options || [] };
    return `<article class="history-question"><div class="history-question-head"><div><span class="type-badge">${typeLabel(question.type)}</span><h3>${escapeHtml(question.title)}</h3></div><strong>${responses.length} respuestas</strong></div><div class="response-history-list">${responses.map(response => `<div class="response-history-row"><span><strong>${escapeHtml(participantMap.get(response.participant_id)?.display_name || "Participante")}</strong><small>${new Date(response.submitted_at).toLocaleString("es-CL")}</small></span><p>${escapeHtml(responseValue(response, question))}</p>${response.is_correct === null ? "" : `<b class="${response.is_correct ? "correct-answer" : "wrong-answer"}">${response.is_correct ? "Correcta" : "Incorrecta"}${response.points ? ` · ${response.points} pts` : ""}</b>`}</div>`).join("")}</div></article>`;
  }).join("");
  const leaderboard = [...session.participants].sort((a, b) => b.score - a.score).map((participant, index) => `<div class="leaderboard-history-row"><b>${index + 1}</b><span>${escapeHtml(participant.display_name)}</span><strong>${participant.score} pts</strong></div>`).join("");
  return adminShell(`<div class="editor-top"><button class="admin-link" data-nav="/results">← Volver a resultados</button><button class="btn secondary" id="refresh-results">Actualizar</button></div><div class="admin-heading"><div><div class="eyebrow">Sala ${escapeHtml(session.code)}</div><h1>${escapeHtml(sessionActivityTitle(session))}</h1><p class="muted">${sessionStatusLabel(session.status)} · ${new Date(session.created_at).toLocaleString("es-CL")}</p></div></div><div class="results-summary"><section class="panel metric"><span class="muted">Participantes</span><strong>${session.participants.length}</strong></section><section class="panel metric"><span class="muted">Respuestas</span><strong>${session.responses.length}</strong></section><section class="panel metric"><span class="muted">Preguntas respondidas</span><strong>${grouped.size}</strong></section></div><div class="results-detail-grid"><section class="panel leaderboard-history"><div class="eyebrow">Leaderboard</div><h2>Clasificación final</h2>${leaderboard || `<p class="muted">Sin participantes con puntaje.</p>`}</section><section class="question-history">${questions || `<div class="panel results-empty"><strong>No hubo respuestas en esta sesión</strong></div>`}</section></div>`, "results");
}

function libraryResultsMarkup(activities) {
  const query = libraryState.query.trim().toLowerCase();
  const filtered = activities.filter(activity => `${activity.title} ${activity.description || ""}`.toLowerCase().includes(query));
  filtered.sort((a, b) => libraryState.sort === "name" ? a.title.localeCompare(b.title, "es") : libraryState.sort === "name-desc" ? b.title.localeCompare(a.title, "es") : libraryState.sort === "oldest" ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt);
  const totalPages = Math.max(1, Math.ceil(filtered.length / libraryState.pageSize));
  libraryState.page = Math.min(libraryState.page, totalPages);
  const start = (libraryState.page - 1) * libraryState.pageSize;
  const pageItems = filtered.slice(start, start + libraryState.pageSize);
  const from = filtered.length ? start + 1 : 0;
  const to = Math.min(start + libraryState.pageSize, filtered.length);
  return `<div class="panel activity-table"><div class="activity-table-row activity-table-head"><span>Actividad</span><span>Módulos</span><span>Última edición</span><span>Acciones</span></div><div id="activity-rows">${activityRowsMarkup(pageItems)}</div>${filtered.length ? "" : `<div class="empty-search"><strong>No encontramos actividades</strong><span>Prueba con otro término de búsqueda.</span></div>`}</div><div class="pagination-bar"><span>Mostrando ${from}–${to} de ${filtered.length}</span><label>Filas por página <select id="activity-page-size"><option value="10" ${libraryState.pageSize === 10 ? "selected" : ""}>10</option><option value="25" ${libraryState.pageSize === 25 ? "selected" : ""}>25</option><option value="50" ${libraryState.pageSize === 50 ? "selected" : ""}>50</option></select></label><div class="page-controls"><button id="page-prev" ${libraryState.page === 1 ? "disabled" : ""}>←</button><strong>Página ${libraryState.page} de ${totalPages}</strong><button id="page-next" ${libraryState.page === totalPages ? "disabled" : ""}>→</button></div></div>`;
}

function activityRowsMarkup(activities) {
  return activities.map(activity => `<article class="activity-table-row activity-row" data-title="${escapeAttr(`${activity.title} ${activity.description || ""}`.toLowerCase())}" data-updated="${activity.updatedAt}" data-name="${escapeAttr(activity.title.toLowerCase())}"><div class="activity-main"><span class="activity-icon compact">${activity.questions.length}</span><span><strong>${escapeHtml(activity.title)}</strong><small>${escapeHtml(activity.description || "Sin descripción")}</small></span></div><span><b>${activity.questions.length}</b> módulos</span><span>${formatDate(activity.updatedAt)}</span><div class="row-actions"><button class="btn secondary edit-activity" data-id="${activity.id}">Editar</button><button class="btn purple present-activity" data-id="${activity.id}">Presentar</button></div></article>`).join("");
}

function usersView() {
  const admin = getAdmin();
  if (admin.platformRole === "super_admin") return platformUsersView();
  const isSupabase = Boolean(window.pulseplaySupabase);
  const users = isSupabase ? workspaceUsers : getUsers().filter(user => user.workspaceId === admin.workspaceId);
  const invitationRows = workspaceInvitations.map(invitation => `<div class="table-row pending-user"><span class="user-cell"><b class="avatar small">${escapeHtml(invitation.email[0].toUpperCase())}</b><span><strong>${escapeHtml(invitation.email)}</strong><small>Invitación enviada</small></span></span><span>Colaborador</span><span class="pending-label">Pendiente</span><span><button class="icon-btn revoke-invitation" data-id="${invitation.id}" title="Revocar invitación">×</button></span></div>`).join("");
  const memberRows = users.map(user => `<div class="table-row"><span class="user-cell"><b class="avatar small">${escapeHtml((user.name || user.email || "?")[0].toUpperCase())}</b><span><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.email)}</small></span></span><span>${user.id === admin.id ? "Administrador del espacio" : "Colaborador"}</span><span class="online-label">Activo</span><span>${user.id === admin.id ? "Tú" : ""}</span></div>`).join("");
  const inviteButton = `<button class="btn" id="toggle-user-form">+ Invitar usuario</button>`;
  const inviteForm = `<form id="user-form" class="panel inline-form team-invite-form hidden"><div class="field"><label>Correo</label><input name="email" type="email" placeholder="persona@empresa.cl" required /></div><button class="btn">Enviar invitación</button><p class="form-help">Podrá colaborar en este espacio. La administración global sigue reservada al equipo de PulsePlay.</p></form>`;
  const loading = isSupabase && !usersReady ? `<div class="panel results-empty"><strong>Cargando equipo...</strong></div>` : `<div class="panel users-table"><div class="table-row table-head"><span>Usuario</span><span>Rol</span><span>Estado</span><span></span></div>${memberRows}${invitationRows || ""}</div>`;
  return adminShell(`<div class="admin-heading"><div><div class="eyebrow">Equipo</div><h1>Colaboradores</h1><p class="muted">Personas invitadas a trabajar en tu espacio.</p></div>${inviteButton}</div>${inviteForm}${loading}`, "users");
}

function platformUsersView() {
  const admin = getAdmin();
  if (!platformUsersReady) return adminShell(`<section class="panel results-empty"><h2>Cargando usuarios de la plataforma...</h2></section>`, "users");
  const rows = platformUsers.map(user => {
    const isSelf = user.id === admin.id;
    const suspended = user.account_status === "suspended";
    const role = user.platform_role === "super_admin" ? "Superadministrador" : "Usuario";
    const provider = user.provider === "google" ? "Google" : "Correo";
    const actions = isSelf ? "Tú" : `<div class="platform-user-actions"><button class="btn secondary platform-user-status" data-id="${user.id}" data-action="${suspended ? "activate" : "suspend"}">${suspended ? "Reactivar" : "Suspender"}</button><button class="icon-btn danger delete-platform-user" data-id="${user.id}" data-name="${escapeAttr(user.name || user.email)}" title="Eliminar cuenta">×</button></div>`;
    return `<div class="platform-user-row"><span class="user-cell"><b class="avatar small">${escapeHtml((user.name || user.email || "?")[0].toUpperCase())}</b><span><strong>${escapeHtml(user.name || "Sin nombre")}</strong><small>${escapeHtml(user.email || "")}</small></span></span><span>${role}</span><span>${provider}</span><span class="${suspended ? "suspended-label" : "online-label"}">${suspended ? "Suspendida" : "Activa"}</span><span>${user.lastSignInAt ? new Date(user.lastSignInAt).toLocaleDateString("es-CL") : "Sin ingreso"}</span><span>${actions}</span></div>`;
  }).join("");
  return adminShell(`<div class="admin-heading"><div><div class="eyebrow">Plataforma</div><h1>Usuarios de PulsePlay</h1><p class="muted">Administra el acceso global, suspende cuentas o elimínalas definitivamente.</p></div><div class="heading-actions"><button class="btn secondary" id="refresh-platform-users">Actualizar</button><button class="btn" id="show-platform-invite">+ Invitar usuario</button></div></div><form class="panel invite-form hidden" id="platform-invite-form"><div class="field grow"><label for="platform-invite-email">Correo electrónico</label><input id="platform-invite-email" type="email" placeholder="persona@empresa.cl" required></div><button class="btn" type="submit">Enviar invitación</button></form><div class="panel platform-users-table"><div class="platform-user-row table-head"><span>Usuario</span><span>Tipo</span><span>Acceso</span><span>Estado</span><span>Último ingreso</span><span>Acciones</span></div>${rows}</div>`, "users");
}

function profileView() {
  const admin = getAdmin();
  const activityCount = getOwnedActivities().length;
  return adminShell(`<div class="admin-heading"><div><div class="eyebrow">Cuenta</div><h1>Mi perfil</h1><p class="muted">Administra tus datos personales y la seguridad de la cuenta.</p></div></div><div class="profile-grid"><form id="profile-form" class="panel profile-card"><div class="profile-hero"><span class="avatar profile-avatar">${escapeHtml(admin.name[0])}</span><div><h2>${escapeHtml(admin.name)}</h2><p>${escapeHtml(admin.email)}</p></div></div><div class="field"><label>Nombre</label><input name="name" value="${escapeAttr(admin.name)}" required /></div><div class="field"><label>Correo</label><input value="${escapeAttr(admin.email)}" disabled /></div><button class="btn full">Guardar perfil</button></form><section class="panel account-summary"><div class="eyebrow">Tu espacio</div><h3>Resumen de cuenta</h3><div class="account-stat"><strong>${activityCount}</strong><span>actividades propias</span></div><div class="account-stat"><strong>${formatDate(admin.createdAt || Date.now())}</strong><span>miembro desde</span></div><button class="btn secondary full" data-nav="/forgot">Cambiar contraseña</button><button class="danger-text" id="profile-logout">Cerrar sesión en este dispositivo</button></section></div>`, "profile");
}

function editorView(activityId) {
  const activity = getOwnedActivity(activityId);
  if (!activity) return dashboardView();
  return adminShell(`<form id="activity-form" data-id="${activity.id}">
    <div class="editor-top"><button type="button" class="admin-link" data-nav="/dashboard">← Volver a actividades</button><div class="editor-actions"><span class="save-state">Sin cambios pendientes</span><button type="submit" class="btn">Guardar cambios</button></div></div>
    <section class="panel activity-settings"><div class="field"><label>Título de la actividad</label><input name="title" value="${escapeAttr(activity.title)}" required /></div><div class="field"><label>Descripción</label><input name="description" value="${escapeAttr(activity.description || "")}" placeholder="Describe brevemente la actividad" /></div></section>
    <div class="editor-heading"><div><div class="eyebrow">Constructor</div><h1>Preguntas y módulos</h1></div></div>
    <div id="question-list" class="question-list">${activity.questions.map((question, index) => questionEditorMarkup(question, index, activity.questions.length)).join("") || `<div class="empty-editor-note"><span>1</span><div><strong>Comienza con tu primer módulo</strong><p>Elige una opción en el menú de abajo.</p></div></div>`}</div>
    <section class="add-module-panel" id="add-module-panel">
      <div class="add-module-heading"><div><div class="eyebrow">Siguiente paso</div><h2>Agregar otro módulo</h2><p class="muted">Elige cómo quieres que participe tu audiencia.</p></div><span class="module-count">${activity.questions.length} ${activity.questions.length === 1 ? "módulo" : "módulos"}</span></div>
      <div class="module-options">
        <button type="button" class="module-option add-question" data-type="quiz"><span class="module-icon quiz-icon">?</span><span><strong>Trivia</strong><small>Una respuesta correcta y puntaje por rapidez</small></span><b>+</b></button>
        <button type="button" class="module-option add-question" data-type="poll"><span class="module-icon poll-icon">▥</span><span><strong>Encuesta</strong><small>Conoce la opinión del público en vivo</small></span><b>+</b></button>
        <button type="button" class="module-option add-question" data-type="wordcloud"><span class="module-icon cloud-icon">Aa</span><span><strong>Nube de palabras</strong><small>Reúne ideas breves y descubre coincidencias</small></span><b>+</b></button>
        <button type="button" class="module-option add-question" data-type="openended"><span class="module-icon text-icon">¶</span><span><strong>Respuesta abierta</strong><small>Recibe textos breves y muéstralos en una grilla</small></span><b>+</b></button>
        <button type="button" class="module-option add-question" data-type="scale"><span class="module-icon scale-icon">1–5</span><span><strong>Escala</strong><small>Mide satisfacción, acuerdo o percepción</small></span><b>+</b></button>
        <button type="button" class="module-option add-question" data-type="ranking"><span class="module-icon ranking-icon">≡</span><span><strong>Ranking</strong><small>Ordena opciones según prioridad o preferencia</small></span><b>+</b></button>
      </div>
      <div class="bottom-save"><div><strong>¿Terminaste de editar?</strong><span>Guarda los cambios y vuelve a tu biblioteca de actividades.</span></div><div class="bottom-save-actions"><button type="button" class="btn secondary" data-nav="/dashboard">Volver a actividades</button><button type="button" class="btn bottom-save-button" id="save-and-return">Guardar y volver</button></div></div>
    </section>
  </form>`, "dashboard");
}

function questionEditorMarkup(question, index, total) {
  const labels = { quiz: "Trivia", poll: "Encuesta", wordcloud: "Nube de palabras", openended: "Respuesta abierta", scale: "Escala", ranking: "Ranking" };
  const options = question.options || ["Opción 1", "Opción 2", "Opción 3", "Opción 4"];
  const editorBody = ["wordcloud", "openended", "scale"].includes(question.type)
    ? (question.type === "wordcloud" ? `<div class="wordcloud-preview"><span>ideas</span><span>equipo</span><span>impacto</span></div>` : question.type === "openended" ? `<div class="openended-preview"><span>Las respuestas aparecerán como tarjetas de texto.</span><span>Ideal para opiniones, reflexiones o sugerencias.</span></div>` : `<div class="scale-editor"><div class="field"><label>Etiqueta mínima</label><input name="scale-min-label" value="${escapeAttr(question.minLabel || "Nada")}" /></div><div class="field"><label>Valores</label><select name="scale-max"><option value="5" ${(question.scaleMax || 5) === 5 ? "selected" : ""}>1 a 5</option><option value="10" ${question.scaleMax === 10 ? "selected" : ""}>1 a 10</option></select></div><div class="field"><label>Etiqueta máxima</label><input name="scale-max-label" value="${escapeAttr(question.maxLabel || "Mucho")}" /></div></div>`)
    : `<div class="option-editor">${options.map((option, optionIndex) => `<label class="option-line">${question.type === "ranking" ? `<span class="ranking-grip">≡</span>` : `<input type="${question.type === "quiz" ? "radio" : "checkbox"}" name="correct-${question.id}" value="${optionIndex}" ${question.type === "quiz" && question.correct === optionIndex ? "checked" : ""} ${question.type === "poll" ? "disabled" : ""} />`}<span class="letter">${"ABCD"[optionIndex]}</span><input class="option-input" data-option-index="${optionIndex}" value="${escapeAttr(option)}" required /></label>`).join("")}</div>`;
  return `<section class="panel question-editor" data-question-id="${question.id}"><div class="question-toolbar"><span class="question-number">${index + 1}</span><span class="type-badge">${labels[question.type]}</span><div class="toolbar-spacer"></div><button type="button" class="icon-btn move-up" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" class="icon-btn move-down" ${index === total - 1 ? "disabled" : ""}>↓</button><button type="button" class="icon-btn danger delete-question">×</button></div><div class="field"><label>Enunciado</label><input name="question-title" value="${escapeAttr(question.title)}" required /></div>${editorBody}<div class="question-footer"><label>Tiempo <select name="duration"><option value="0" ${question.duration === 0 ? "selected" : ""}>Sin límite</option><option value="15" ${question.duration === 15 ? "selected" : ""}>15 segundos</option><option value="20" ${question.duration === 20 ? "selected" : ""}>20 segundos</option><option value="30" ${question.duration === 30 ? "selected" : ""}>30 segundos</option><option value="60" ${question.duration === 60 ? "selected" : ""}>60 segundos</option></select></label><span class="muted">${question.type === "quiz" ? "Competitiva: suma puntos al leaderboard" : question.type === "ranking" ? "Orden de preferencia, sin puntos" : question.type === "scale" ? "Valoración, sin puntos" : question.type === "poll" ? "Sin respuesta correcta ni puntos" : question.type === "openended" ? "Texto breve, una respuesta por persona" : "Una respuesta por persona"}</span></div></section>`;
}

function participantView(room) {
  if (!localPlayer) return homeView();
  if (room.blockedParticipants?.includes(localPlayer.id)) return shell(`<main class="room"><section class="panel stage-card waiting"><div class="waiting-orb blocked">×</div><div class="eyebrow">Sesión cerrada</div><h1>El presentador te retiró de la sala</h1><p class="muted">Puedes volver al inicio y entrar a otra actividad.</p><button class="btn" data-nav="/">Volver al inicio</button></section></main>`);
  const questions = getQuestions(room);
  const current = questions[room.index];
  if (!current && room.status !== "lobby" && room.status !== "finished") return shell(`<main class="room"><section class="panel empty-state"><h2>Esta actividad no tiene preguntas.</h2></section></main>`);
  const answerKey = `${room.index}:${localPlayer.id}`;
  const submitted = room.answers[answerKey];
  let body = "";
  if (room.status === "lobby") body = `<section class="panel stage-card waiting"><div class="waiting-orb">${escapeHtml(localPlayer.name[0].toUpperCase())}</div><div class="eyebrow">Ya estás dentro</div><h1>Hola, ${escapeHtml(localPlayer.name)}</h1><p class="muted">Espera a que el presentador comience la actividad.</p><div class="player-list">${room.participants.map(p => `<span class="player-pill">${escapeHtml(p.name)}</span>`).join("")}</div></section>`;
  else if (room.status === "finished") body = leaderboardMarkup(room, `¡Gran partida, ${escapeHtml(localPlayer.name)}!`);
  else if (room.status === "leaderboard") body = leaderboardMarkup(room, "Clasificación provisional");
  else if (room.status === "results") body = participantResultsMarkup(room, current, submitted);
  else if (current.type === "scale") body = scaleParticipantMarkup(room, current, submitted, questions.length);
  else if (current.type === "ranking") body = rankingParticipantMarkup(room, current, submitted, questions.length);
  else if (current.type === "openended") body = `<section class="panel stage-card waiting">${timerMarkup(room, current)}<div class="question-count">Pregunta ${room.index + 1} de ${questions.length}</div><h1 class="question-title centered">${escapeHtml(current.title)}</h1>${submitted ? `<div class="open-response-sent"><strong>Respuesta enviada</strong><p>${escapeHtml(submitted.text)}</p></div>` : `<form id="openended-form" class="openended-form"><textarea name="text" maxlength="280" rows="5" placeholder="Escribe una respuesta breve…" required></textarea><div><span class="muted">Máximo 280 caracteres</span><button class="btn">Enviar respuesta</button></div></form>`}</section>`;
  else if (current.type === "wordcloud") body = `<section class="panel stage-card waiting">${timerMarkup(room, current)}<div class="question-count">Pregunta ${room.index + 1} de ${questions.length}</div><h1 class="question-title">${escapeHtml(current.title)}</h1>${submitted ? `<p class="eyebrow">Respuesta enviada</p><p class="muted">La nube aparecerá al cerrar la pregunta.</p>` : `<form id="word-form" class="word-form"><input name="word" maxlength="28" placeholder="Escribe una palabra…" required /><button class="btn">Enviar</button></form>`}</section>`;
  else body = `<section class="panel stage-card">${timerMarkup(room, current)}<div class="question-count">Pregunta ${room.index + 1} de ${questions.length}</div><h1 class="question-title">${escapeHtml(current.title)}</h1><div class="answers">${current.options.map((option, i) => { const selected = submitted?.option === i; return `<button class="answer ${selected ? "selected" : ""}" data-answer="${i}" ${submitted ? "disabled" : ""}><span class="letter">${"ABCD"[i]}</span><strong>${escapeHtml(option)}</strong></button>`; }).join("")}</div>${submitted ? `<p class="muted response-message">Respuesta enviada. Esperando…</p>` : ""}</section>`;
  return shell(`<main class="room"><div class="room-head"><div><div class="eyebrow">Participante</div><strong>${escapeHtml(localPlayer.name)} · ${playerScore(room, localPlayer.id)} pts</strong></div><div class="room-code"><span class="status-dot"></span>Sala <strong>${room.code}</strong></div></div>${body}</main>`);
}

function presenterView(room) {
  const activity = getActivity(room.activityId);
  const questions = activity?.questions || [];
  const current = questions[room.index];
  const questionAnswers = Object.entries(room.answers).filter(([key]) => key.startsWith(`${room.index}:`));
  let stage = "";
  if (room.status === "lobby") stage = `<section class="panel stage-card waiting"><div class="eyebrow">Sala abierta</div><h1>Únete con el código <span class="gradient-text">${room.code}</span></h1><p class="muted">${escapeHtml(activity?.title || room.activityTitle || "Actividad")}</p><div class="player-list">${room.participants.length ? room.participants.map(p => `<span class="player-pill">${escapeHtml(p.name)}</span>`).join("") : `<span class="muted">Esperando participantes…</span>`}</div></section>`;
  else if (room.status === "finished") stage = leaderboardMarkup(room, "Resultados finales");
  else if (room.status === "leaderboard") stage = leaderboardMarkup(room, "Clasificación provisional");
  else if (room.status === "results") stage = presenterResultsMarkup(room, current, questionAnswers);
  else if (["scale", "ranking"].includes(current?.type)) stage = `<section class="panel stage-card waiting">${timerMarkup(room, current)}<div class="question-count">Pregunta ${room.index + 1} de ${questions.length}</div><h1 class="question-title centered">${escapeHtml(current.title)}</h1><div class="open-live-state"><strong>${questionAnswers.length}</strong><span>respuestas recibidas</span><p class="muted">Los resultados aparecerán al cerrar la pregunta.</p></div></section>`;
  else if (current?.type === "openended") stage = `<section class="panel stage-card waiting">${timerMarkup(room, current)}<div class="question-count">Pregunta ${room.index + 1} de ${questions.length}</div><h1 class="question-title centered">${escapeHtml(current.title)}</h1><div class="open-live-state"><strong>${questionAnswers.length}</strong><span>respuestas recibidas</span><p class="muted">Las tarjetas se mostrarán cuando cierres la pregunta.</p></div></section>`;
  else if (current?.type === "wordcloud") stage = `<section class="panel stage-card waiting">${timerMarkup(room, current)}<div class="question-count">Pregunta ${room.index + 1} de ${questions.length}</div><h1 class="question-title">${escapeHtml(current.title)}</h1><div class="cloud">${cloudMarkup(room.words) || `<span class="muted cloud-placeholder">Esperando palabras…</span>`}</div></section>`;
  else if (current) { const counts = current.options.map((_, option) => questionAnswers.filter(([, value]) => value.option === option).length); stage = `<section class="panel stage-card">${timerMarkup(room, current)}<div class="question-count">Pregunta ${room.index + 1} de ${questions.length}</div><h1 class="question-title">${escapeHtml(current.title)}</h1><div class="answers">${current.options.map((option, i) => `<div class="answer ${room.reveal && current.type === "quiz" && i === current.correct ? "correct" : ""}"><span class="letter">${"ABCD"[i]}</span><strong class="flex-grow">${escapeHtml(option)}</strong>${room.reveal ? `<b>${counts[i]}</b>` : ""}</div>`).join("")}</div></section>`; }
  else stage = `<section class="panel stage-card waiting"><h1>Agrega preguntas antes de presentar</h1><button class="btn" data-nav="/editor/${activity?.id}">Abrir editor</button></section>`;
  const isFinalLeaderboard = room.status === "finished" || (room.status === "leaderboard" && room.index === questions.length - 1);
  const primaryLabel = room.status === "lobby" ? "Comenzar actividad" : room.status === "question" ? "Cerrar respuestas" : room.status === "results" ? "Ver clasificación" : "Siguiente pregunta";
  const controls = isFinalLeaderboard
    ? `<div class="final-session-actions"><button id="finish-and-results" class="btn purple">Finalizar y ver resultados</button><button id="present-again" class="btn secondary">Presentar nuevamente</button><button class="admin-link" data-nav="/dashboard">Volver al estudio</button></div>`
    : `<button id="admin-next" class="btn purple" ${questions.length ? "" : "disabled"}>${primaryLabel}</button><button class="admin-link" data-nav="/dashboard">Volver al estudio</button>`;
  return shell(`<main class="room"><div class="room-head"><div><div class="eyebrow">Panel del presentador</div><strong>${escapeHtml(activity?.title || room.activityTitle || "Actividad")}</strong></div><div class="room-code"><span class="status-dot"></span>Sala <strong>${room.code}</strong></div></div><div class="presenter-grid"><div>${stage}</div><aside class="panel control-panel"><h3>Control en vivo</h3><div class="metric"><span class="muted">Participantes</span><strong>${room.participants.length}</strong></div><div class="metric"><span class="muted">Respuestas</span><strong>${current?.type === "wordcloud" ? room.words.length : questionAnswers.length}</strong></div><div class="participant-control"><span class="control-label">En la sala</span>${room.participants.length ? room.participants.map(player => `<div class="participant-row"><span>${escapeHtml(player.name)}</span><button class="kick-player" data-id="${player.id}" title="Expulsar">×</button></div>`).join("") : `<small class="muted">Sin participantes</small>`}</div><div class="steps">${questions.map((q, i) => `<div class="step ${room.status !== "lobby" && i === room.index ? "active" : ""}">${i + 1}. ${typeLabel(q.type)}</div>`).join("")}<div class="step ${["leaderboard", "finished"].includes(room.status) ? "active" : ""}">★ Leaderboard</div></div>${controls}</aside></div></main>`, getAdmin() ? `<button class="admin-link" id="admin-logout">Cerrar sesión</button>` : `<button class="admin-link" data-nav="/login">Administrar</button>`);
}

function participantResultsMarkup(room, current, submitted) {
  if (current.type === "wordcloud") return `<section class="panel stage-card waiting"><div class="eyebrow">Resultados</div><h1 class="question-title centered">${escapeHtml(current.title)}</h1><div class="cloud">${cloudMarkup(room.words) || `<span class="muted cloud-placeholder">No se enviaron palabras</span>`}</div></section>`;
  if (current.type === "openended") return `<section class="panel stage-card waiting"><div class="eyebrow">Respuestas abiertas</div><h1 class="question-title centered">${escapeHtml(current.title)}</h1><p class="muted">${submitted ? "Tu respuesta se agregó a la grilla." : "El tiempo terminó."}</p>${openResponsesMarkup(room)}</section>`;
  if (current.type === "scale") return scaleResultsMarkup(room, current, submitted?.value);
  if (current.type === "ranking") return rankingResultsMarkup(room, current);
  const counts = answerCounts(room, current);
  return `<section class="panel stage-card"><div class="result-verdict ${submitted?.correct ? "success" : ""}">${current.type === "quiz" ? (submitted?.correct ? `¡Correcto! +${submitted.points} puntos` : submitted ? "Respuesta incorrecta" : "Tiempo agotado") : "Resultados de la encuesta"}</div><h1 class="question-title">${escapeHtml(current.title)}</h1>${resultsBarsMarkup(current, counts, submitted?.option)}</section>`;
}

function presenterResultsMarkup(room, current) {
  if (current.type === "wordcloud") return `<section class="panel stage-card waiting"><div class="eyebrow">Resultados</div><h1 class="question-title centered">${escapeHtml(current.title)}</h1><div class="cloud">${cloudMarkup(room.words) || `<span class="muted cloud-placeholder">No se enviaron palabras</span>`}</div></section>`;
  if (current.type === "openended") return `<section class="panel stage-card open-results-stage"><div class="eyebrow">Respuestas abiertas</div><h1 class="question-title">${escapeHtml(current.title)}</h1>${openResponsesMarkup(room)}</section>`;
  if (current.type === "scale") return scaleResultsMarkup(room, current);
  if (current.type === "ranking") return rankingResultsMarkup(room, current);
  return `<section class="panel stage-card"><div class="eyebrow">Resultados de la pregunta</div><h1 class="question-title">${escapeHtml(current.title)}</h1>${resultsBarsMarkup(current, answerCounts(room, current))}</section>`;
}

function answerCounts(room, current) {
  const currentAnswers = Object.entries(room.answers).filter(([key]) => key.startsWith(`${room.index}:`)).map(([, value]) => value);
  return current.options.map((_, option) => currentAnswers.filter(answer => answer.option === option).length);
}

function resultsBarsMarkup(current, counts, selectedOption = -1) {
  const max = Math.max(1, ...counts);
  return `<div class="result-bars">${current.options.map((option, index) => `<div class="result-row ${current.type === "quiz" && index === current.correct ? "correct" : ""} ${selectedOption === index ? "selected" : ""}"><div class="result-label"><span>${"ABCD"[index]}. ${escapeHtml(option)}</span><strong>${counts[index]}</strong></div><div class="bar-track"><div class="bar-fill" style="width:${counts[index] / max * 100}%"></div></div></div>`).join("")}</div>`;
}

function leaderboardMarkup(room, title) { const players = [...room.participants].sort((a, b) => playerScore(room, b.id) - playerScore(room, a.id)); return `<section class="panel stage-card waiting"><div class="eyebrow">Leaderboard competitivo</div><h1 class="question-title centered">${title}</h1><p class="muted">Solo las respuestas correctas de trivia suman puntos.</p><div class="leaderboard">${players.length ? players.map((p, i) => `<div class="leader-row"><span class="rank">${i + 1}</span><strong>${escapeHtml(p.name)}</strong><span class="points">${playerScore(room, p.id)} pts</span></div>`).join("") : `<p class="muted">Aún no hay participantes.</p>`}</div></section>`; }
function playerScore(room, playerId) { const participant = room.participants.find(player => player.id === playerId); if (Number.isFinite(participant?.score)) return participant.score; return Object.entries(room.answers).filter(([key]) => key.endsWith(`:${playerId}`)).reduce((sum, [, answer]) => sum + (answer.points || 0), 0); }
function timerMarkup(room, current) { if (room.status !== "question") return ""; if (!room.endsAt) return `<div class="untimed-badge"><span class="status-dot"></span>Sin límite de tiempo</div>`; const remaining = Math.max(0, Math.ceil((room.endsAt - Date.now()) / 1000)); return `<div class="timer-wrap"><div class="timer"><div class="timer-fill" style="width:${remaining / current.duration * 100}%"></div></div><strong class="timer-number">${remaining}</strong></div>`; }
function cloudMarkup(words) { const grouped = words.reduce((acc, item) => { const key = item.word.toLowerCase(); acc[key] = (acc[key] || 0) + 1; return acc; }, {}); return Object.entries(grouped).sort((a,b) => b[1] - a[1]).map(([word, count]) => `<span style="font-size:${22 + count * 11}px">${escapeHtml(word)}</span>`).join(""); }
function openResponsesMarkup(room) { const responses = Object.entries(room.answers).filter(([key, value]) => key.startsWith(`${room.index}:`) && value.text).map(([key, value]) => ({ ...value, playerId: key.split(":")[1] })); return `<div class="open-response-grid">${responses.length ? responses.map(response => `<article class="open-response-card"><p>${escapeHtml(response.text)}</p><span>${escapeHtml(room.participants.find(player => player.id === response.playerId)?.name || "Participante")}</span></article>`).join("") : `<div class="empty-responses"><strong>No se recibieron respuestas</strong><span class="muted">La grilla aparecerá aquí.</span></div>`}</div>`; }
function scaleParticipantMarkup(room, current, submitted, total) {
  const max = current.scaleMax || 5;
  return `<section class="panel stage-card waiting">${timerMarkup(room, current)}<div class="question-count">Pregunta ${room.index + 1} de ${total}</div><h1 class="question-title centered">${escapeHtml(current.title)}</h1>${submitted ? `<div class="scale-submitted"><strong>${submitted.value}</strong><span>Valoración enviada</span></div>` : `<form id="scale-form" class="scale-form"><div class="scale-labels"><span>${escapeHtml(current.minLabel || "Nada")}</span><span>${escapeHtml(current.maxLabel || "Mucho")}</span></div><div class="scale-buttons">${Array.from({ length: max }, (_, index) => `<label><input type="radio" name="value" value="${index + 1}" required /><span>${index + 1}</span></label>`).join("")}</div><button class="btn">Enviar valoración</button></form>`}</section>`;
}
function rankingParticipantMarkup(room, current, submitted, total) {
  const order = submitted?.ranking || current.options.map((_, index) => index);
  return `<section class="panel stage-card waiting">${timerMarkup(room, current)}<div class="question-count">Pregunta ${room.index + 1} de ${total}</div><h1 class="question-title centered">${escapeHtml(current.title)}</h1>${submitted ? `<div class="ranking-submitted"><strong>Orden enviado</strong>${order.map((optionIndex, rank) => `<span><b>${rank + 1}</b>${escapeHtml(current.options[optionIndex])}</span>`).join("")}</div>` : `<form id="ranking-form" class="ranking-form"><p class="muted">Usa las flechas para ordenar de mayor a menor prioridad.</p><div id="ranking-items">${order.map((optionIndex, rank) => `<div class="ranking-item" data-option="${optionIndex}"><b>${rank + 1}</b><span>${escapeHtml(current.options[optionIndex])}</span><button type="button" class="rank-up" ${rank === 0 ? "disabled" : ""}>↑</button><button type="button" class="rank-down" ${rank === order.length - 1 ? "disabled" : ""}>↓</button></div>`).join("")}</div><button class="btn">Enviar ranking</button></form>`}</section>`;
}
function scaleResultsMarkup(room, current, selectedValue) {
  const values = Object.entries(room.answers).filter(([key, answer]) => key.startsWith(`${room.index}:`) && Number.isFinite(answer.value)).map(([, answer]) => answer.value);
  const max = current.scaleMax || 5;
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const counts = Array.from({ length: max }, (_, index) => values.filter(value => value === index + 1).length);
  return `<section class="panel stage-card"><div class="eyebrow">Resultado de escala · sin puntos</div><h1 class="question-title">${escapeHtml(current.title)}</h1><div class="scale-summary"><strong>${average.toFixed(1)}</strong><span>promedio de ${max}</span><small>${values.length} respuestas</small></div><div class="scale-distribution">${counts.map((count, index) => `<div class="scale-column ${selectedValue === index + 1 ? "selected" : ""}"><b>${count}</b><div><span style="height:${values.length ? Math.max(5, count / values.length * 100) : 5}%"></span></div><label>${index + 1}</label></div>`).join("")}</div></section>`;
}
function rankingResultsMarkup(room, current) {
  const rankings = Object.entries(room.answers).filter(([key, answer]) => key.startsWith(`${room.index}:`) && Array.isArray(answer.ranking)).map(([, answer]) => answer.ranking);
  const scored = current.options.map((option, optionIndex) => { const positions = rankings.map(ranking => ranking.indexOf(optionIndex)).filter(position => position >= 0); return { option, average: positions.length ? positions.reduce((sum, position) => sum + position + 1, 0) / positions.length : 999 }; }).sort((a, b) => a.average - b.average);
  return `<section class="panel stage-card"><div class="eyebrow">Ranking grupal · sin puntos</div><h1 class="question-title">${escapeHtml(current.title)}</h1><div class="ranking-results">${rankings.length ? scored.map((item, index) => `<div><b>${index + 1}</b><span>${escapeHtml(item.option)}</span><small>posición media ${item.average.toFixed(1)}</small></div>`).join("") : `<p class="muted">No se recibieron rankings.</p>`}</div></section>`;
}
function typeLabel(type) { return ({ quiz: "Trivia", poll: "Encuesta", wordcloud: "Nube de palabras", openended: "Respuesta abierta", scale: "Escala", ranking: "Ranking" })[type] || type; }
function formatDate(timestamp) { return new Intl.DateTimeFormat("es", { day: "numeric", month: "short" }).format(timestamp); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
function escapeAttr(value) { return escapeHtml(value); }
function requireAdmin() { if (!getAdmin()) { navigate("/login"); return false; } return true; }

function collectActivity(form) {
  const original = getActivity(form.dataset.id);
  const questions = [...form.querySelectorAll(".question-editor")].map(card => {
    const type = original.questions.find(q => q.id === card.dataset.questionId)?.type || "quiz";
    const result = { id: card.dataset.questionId, type, title: card.querySelector('[name="question-title"]').value.trim(), duration: Number(card.querySelector('[name="duration"]').value) };
    if (!["wordcloud", "openended", "scale"].includes(type)) result.options = [...card.querySelectorAll(".option-input")].map(input => input.value.trim());
    if (type === "quiz") result.correct = Number(card.querySelector(`input[name="correct-${result.id}"]:checked`)?.value || 0);
    if (type === "scale") { result.scaleMax = Number(card.querySelector('[name="scale-max"]').value); result.minLabel = card.querySelector('[name="scale-min-label"]').value.trim(); result.maxLabel = card.querySelector('[name="scale-max-label"]').value.trim(); }
    return result;
  });
  return {
    ...original,
    title: form.querySelector('[name="title"]').value.trim(),
    description: form.querySelector('[name="description"]').value.trim(),
    updatedAt: Date.now(),
    questions,
  };
}

function updateEditorActivity(form, transform) {
  const activity = collectActivity(form);
  transform(activity);
  const items = getActivities().map(item => item.id === activity.id ? activity : item);
  saveActivities(items);
  editorDirty = true;
  render();
}

function refreshRankingNumbers() {
  const items = [...document.querySelectorAll(".ranking-item")];
  items.forEach((item, index) => {
    item.querySelector("b").textContent = index + 1;
    item.querySelector(".rank-up").disabled = index === 0;
    item.querySelector(".rank-down").disabled = index === items.length - 1;
  });
}

function questionIsClosed(room) {
  return room.status !== "question" || (room.endsAt && Date.now() >= room.endsAt);
}

async function saveActivityForm(form) {
  if (!form.reportValidity()) return false;
  const activity = collectActivity(form);
  try {
    await persistActivity(activity);
  } catch (error) {
    console.error("No se pudo guardar la actividad", error);
    showToast(error?.message ? `No se pudo guardar: ${error.message}` : "No se pudo guardar en Supabase");
    return false;
  }
  editorDirty = false;
  updateSaveState();
  return true;
}

function updateSaveState() {
  const state = document.querySelector(".save-state");
  if (!state) return;
  state.textContent = editorDirty ? "Cambios sin guardar" : "Cambios guardados";
  state.classList.toggle("dirty", editorDirty);
}

function navigateSafely(path) {
  if (route.startsWith("/editor/") && editorDirty && !window.confirm("Tienes cambios sin guardar. ¿Quieres salir sin guardarlos?")) return;
  editorDirty = false;
  navigate(path);
}

function bindEvents() {
  document.querySelectorAll("[data-nav]").forEach(el => el.addEventListener("click", () => navigateSafely(el.dataset.nav)));
  document.querySelectorAll("#admin-logout, #profile-logout").forEach(button => button.addEventListener("click", async () => {
    if (window.pulseplaySupabase) await window.pulseplaySupabase.auth.signOut();
    localStorage.removeItem(ADMIN_SESSION_KEY);
    sessionStorage.removeItem(ADMIN_SESSION_KEY);
    supabaseAdmin = null;
    navigate("/");
  }));
  document.querySelector("#google-auth")?.addEventListener("click", async () => {
    if (!authProviders.google) return showToast("Google todavía no está habilitado en Supabase");
    if (!window.pulseplaySupabase) return showToast("Falta agregar la clave pública de Supabase");
    const { error } = await window.pulseplaySupabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: authRedirect() },
    });
    if (error) showToast(error.message);
  });
  document.querySelector("#login-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email")).trim().toLowerCase();
    const password = String(data.get("password"));
    if (window.isSupabaseConfigured?.()) {
      if (!window.pulseplaySupabase) return showToast("Supabase no está disponible. Recarga la página");
      const { data: authData, error } = await window.pulseplaySupabase.auth.signInWithPassword({ email, password });
      if (error) return showToast("Correo o contraseña incorrectos");
      await loadSupabaseAdmin(authData.user);
      navigate("/dashboard");
      return;
    }
    const user = getUsers().find(item => item.email.toLowerCase() === email && item.password === password);
    if (!user) return showToast("Correo o contraseña incorrectos");
    localStorage.removeItem(ADMIN_SESSION_KEY);
    sessionStorage.removeItem(ADMIN_SESSION_KEY);
    (data.get("remember") ? localStorage : sessionStorage).setItem(ADMIN_SESSION_KEY, user.id);
    navigate("/dashboard");
  });
  document.querySelector("#register-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name")).trim();
    const email = String(data.get("email")).trim().toLowerCase();
    const password = String(data.get("password"));
    if (password !== data.get("confirmPassword")) return showToast("Las contraseñas no coinciden");
    if (window.isSupabaseConfigured?.()) {
      if (!window.pulseplaySupabase) return showToast("Supabase no está disponible. Recarga la página");
      const { data: authData, error } = await window.pulseplaySupabase.auth.signUp({
        email,
        password,
        options: { data: { full_name: name }, emailRedirectTo: `${authRedirect()}?confirmed=1` },
      });
      if (error) return showToast(error.message);
      if (authData.session) {
        await loadSupabaseAdmin(authData.user);
        navigate("/dashboard");
      } else {
        navigate("/login");
        showToast("Revisa tu correo para confirmar la cuenta");
      }
      return;
    }
    if (getUsers().some(user => user.email.toLowerCase() === email)) return showToast("Ya existe una cuenta con ese correo");
    const id = crypto.randomUUID();
    const user = { id, workspaceId: id, name, email, password, role: "owner", createdAt: Date.now() };
    saveUsers([...getUsers(), user]);
    localStorage.setItem(ADMIN_SESSION_KEY, user.id);
    const starter = { ...defaultActivity(), id: crypto.randomUUID(), ownerId: user.id, workspaceId: id, title: "Mi primera actividad", updatedAt: Date.now() };
    saveActivities([...getActivities(), starter]);
    navigate("/dashboard");
    showToast("Cuenta creada correctamente");
  });
  document.querySelector("#forgot-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email")).trim().toLowerCase();
    if (window.isSupabaseConfigured?.()) {
      if (!window.pulseplaySupabase) return showToast("Supabase no está disponible. Recarga la página");
      const { error } = await window.pulseplaySupabase.auth.resetPasswordForEmail(email, { redirectTo: authRedirect() });
      if (error) return showToast(error.message);
      navigate("/login");
      showToast("Te enviamos un enlace para restablecer tu contraseña");
      return;
    }
    if (!getUsers().some(user => user.email.toLowerCase() === email)) return showToast("No encontramos una cuenta con ese correo");
    navigate(`/reset/${encodeURIComponent(email)}`);
  });
  document.querySelector("#reset-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const password = String(data.get("password"));
    if (password !== data.get("confirmPassword")) return showToast("Las contraseñas no coinciden");
    if (window.pulseplaySupabase) {
      const { error } = await window.pulseplaySupabase.auth.updateUser({ password });
      if (error) return showToast(error.message);
      navigate("/dashboard");
      showToast("Contraseña actualizada");
      return;
    }
    const email = event.currentTarget.dataset.email.toLowerCase();
    saveUsers(getUsers().map(user => user.email.toLowerCase() === email ? { ...user, password } : user));
    localStorage.removeItem(ADMIN_SESSION_KEY);
    sessionStorage.removeItem(ADMIN_SESSION_KEY);
    navigate("/login");
    showToast("Contraseña actualizada");
  });
  document.querySelector("#join-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const code = String(data.get("code")).trim();
    const name = String(data.get("name")).trim();
    if (window.pulseplaySupabase) {
      try { await joinLiveSession(code, name); navigate("/play"); }
      catch (error) { showToast(error.message || "No se pudo entrar a la sala"); }
      return;
    }
    const room = getRoom();
    if (!room.code || code !== room.code) return showToast("Código de sala incorrecto");
    localPlayer = { id: clientId, clientId, name };
    sessionStorage.setItem("pulseplay-player", JSON.stringify(localPlayer));
    mutateRoom(next => { const existing = next.participants.find(p => p.id === localPlayer.id); if (existing) existing.name = localPlayer.name; else next.participants.push(localPlayer); });
    navigate("/play");
  });
  document.querySelector("#new-activity")?.addEventListener("click", async () => {
    const id = crypto.randomUUID();
    const admin = getAdmin();
    const activity = { id, ownerId: admin.id, workspaceId: admin.workspaceId, title: "Nueva actividad", description: "", status: "draft", updatedAt: Date.now(), questions: [] };
    if (window.pulseplaySupabase) {
      const { error } = await window.pulseplaySupabase.from("activities").insert({
        id,
        workspace_id: admin.workspaceId,
        created_by: admin.id,
        title: activity.title,
        description: "",
        status: "draft",
      });
      if (error) return showToast("No se pudo crear la actividad");
    }
    saveActivities([activity, ...getActivities()]);
    navigate(`/editor/${id}`);
  });
  document.querySelectorAll(".edit-activity").forEach(button => button.addEventListener("click", () => navigate(`/editor/${button.dataset.id}`)));
  document.querySelectorAll(".present-activity").forEach(button => button.addEventListener("click", async () => {
    try { await createLiveSession(button.dataset.id); navigate("/admin"); }
    catch (error) { showToast(error.message || "No se pudo crear la sala"); }
  }));
  document.querySelector("#activity-search")?.addEventListener("input", event => { libraryState.query = event.target.value; libraryState.page = 1; refreshLibraryResults(); });
  document.querySelector("#activity-sort")?.addEventListener("change", event => { libraryState.sort = event.target.value; libraryState.page = 1; refreshLibraryResults(); });
  document.querySelector("#activity-page-size")?.addEventListener("change", event => { libraryState.pageSize = Number(event.target.value); libraryState.page = 1; refreshLibraryResults(); });
  document.querySelector("#page-prev")?.addEventListener("click", () => { libraryState.page -= 1; refreshLibraryResults(); });
  document.querySelector("#page-next")?.addEventListener("click", () => { libraryState.page += 1; refreshLibraryResults(); });
  document.querySelector("#toggle-user-form")?.addEventListener("click", () => document.querySelector("#user-form").classList.toggle("hidden"));
  document.querySelector("#user-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get("email")).trim().toLowerCase();
    const submit = form.querySelector("button[type='submit'], button:not([type])");
    submit.disabled = true;
    try {
      const { data: result, error } = await window.pulseplaySupabase.functions.invoke("invite-workspace-member", {
        body: { email, workspaceId: getAdmin().workspaceId },
      });
      if (error) throw error;
      if (result?.error) throw new Error(result.error);
      await loadWorkspaceUsers();
      render();
      showToast(result?.message || "Invitación enviada");
    } catch (error) {
      showToast(error.message || "No se pudo enviar la invitación");
      submit.disabled = false;
    }
  });
  document.querySelectorAll(".revoke-invitation").forEach(button => button.addEventListener("click", async () => {
    const { error } = await window.pulseplaySupabase.from("workspace_invitations").delete().eq("id", button.dataset.id);
    if (error) return showToast(error.message);
    await loadWorkspaceUsers();
    render();
    showToast("Invitación revocada");
  }));
  document.querySelector("#refresh-platform-users")?.addEventListener("click", async () => { await loadPlatformUsers(); render(); });
  document.querySelector("#show-platform-invite")?.addEventListener("click", () => document.querySelector("#platform-invite-form")?.classList.toggle("hidden"));
  document.querySelector("#platform-invite-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const email = document.querySelector("#platform-invite-email")?.value.trim();
    if (!email) return;
    const button = event.submitter;
    button.disabled = true;
    button.textContent = "Enviando...";
    await managePlatformUser("invite", null, { email });
    button.disabled = false;
    button.textContent = "Enviar invitación";
  });
  document.querySelectorAll(".platform-user-status").forEach(button => button.addEventListener("click", async () => {
    await managePlatformUser(button.dataset.action, button.dataset.id);
  }));
  document.querySelectorAll(".delete-platform-user").forEach(button => button.addEventListener("click", async () => {
    if (!window.confirm(`Eliminar definitivamente la cuenta de ${button.dataset.name} y todos sus datos propios? Esta acción no se puede deshacer.`)) return;
    await managePlatformUser("delete", button.dataset.id);
  }));
  document.querySelector("#profile-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name")).trim();
    const admin = getAdmin();
    if (window.pulseplaySupabase) {
      const { error } = await window.pulseplaySupabase.from("profiles").update({ name }).eq("id", admin.id);
      if (error) return showToast(error.message);
      supabaseAdmin = { ...admin, name };
    } else {
      saveUsers(getUsers().map(user => user.id === admin.id ? { ...user, name } : user));
    }
    render();
    showToast("Perfil actualizado");
  });
  document.querySelector("#refresh-results")?.addEventListener("click", async () => {
    try { await loadSessionHistory(); render(); showToast("Resultados actualizados"); }
    catch (error) { showToast(error.message || "No se pudieron actualizar los resultados"); }
  });
  document.querySelector("#results-search")?.addEventListener("input", event => { resultsState.query = event.target.value; resultsState.page = 1; refreshResultsList(); });
  document.querySelector("#results-sort")?.addEventListener("change", event => { resultsState.sort = event.target.value; resultsState.page = 1; refreshResultsList(); });
  document.querySelector("#results-status")?.addEventListener("change", event => { resultsState.status = event.target.value; resultsState.page = 1; refreshResultsList(); });
  bindResultsPaginationEvents();
  const activityForm = document.querySelector("#activity-form");
  activityForm?.addEventListener("input", () => { editorDirty = true; updateSaveState(); });
  activityForm?.addEventListener("change", () => { editorDirty = true; updateSaveState(); });
  activityForm?.addEventListener("submit", async event => { event.preventDefault(); if (await saveActivityForm(event.currentTarget)) showToast("Cambios guardados"); });
  document.querySelector("#save-and-return")?.addEventListener("click", async () => { const form = document.querySelector("#activity-form"); if (await saveActivityForm(form)) { showToast("Actividad guardada"); navigate("/dashboard"); } });
  document.querySelectorAll(".add-question").forEach(button => button.addEventListener("click", () => {
    const newQuestionId = crypto.randomUUID();
    sessionStorage.setItem("pulseplay-scroll-question", newQuestionId);
    updateEditorActivity(document.querySelector("#activity-form"), activity => { const type = button.dataset.type; const question = { id: newQuestionId, type, title: type === "wordcloud" ? "¿Qué palabra describe mejor tu experiencia?" : type === "openended" ? "Comparte una reflexión breve" : type === "scale" ? "¿Cómo evaluarías esta experiencia?" : type === "ranking" ? "Ordena estas opciones según tu prioridad" : type === "poll" ? "¿Cuál opción prefieres?" : "Escribe aquí tu pregunta", duration: ["openended", "ranking"].includes(type) ? 60 : 20 }; if (!["wordcloud", "openended", "scale"].includes(type)) question.options = ["Opción 1", "Opción 2", "Opción 3", "Opción 4"]; if (type === "quiz") question.correct = 0; if (type === "scale") Object.assign(question, { scaleMax: 5, minLabel: "Nada", maxLabel: "Mucho" }); activity.questions.push(question); });
  }));
  document.querySelectorAll(".delete-question").forEach(button => button.addEventListener("click", () => updateEditorActivity(document.querySelector("#activity-form"), activity => { activity.questions = activity.questions.filter(q => q.id !== button.closest(".question-editor").dataset.questionId); })));
  document.querySelectorAll(".move-up, .move-down").forEach(button => button.addEventListener("click", () => updateEditorActivity(document.querySelector("#activity-form"), activity => { const id = button.closest(".question-editor").dataset.questionId; const from = activity.questions.findIndex(q => q.id === id); const to = button.classList.contains("move-up") ? from - 1 : from + 1; if (to < 0 || to >= activity.questions.length) return; [activity.questions[from], activity.questions[to]] = [activity.questions[to], activity.questions[from]]; })));
  document.querySelectorAll("[data-answer]").forEach(button => button.addEventListener("click", async () => {
    const room = getRoom();
    if (questionIsClosed(room)) return showToast("La pregunta ya está cerrada");
    const option = Number(button.dataset.answer);
    if (room.id && window.pulseplaySupabase) {
      try { await submitLiveResponse({ option }); showToast("¡Respuesta enviada!"); }
      catch (error) { showToast(error.message || "No se pudo enviar la respuesta"); }
      return;
    }
    const current = getQuestions(room)[room.index];
    const elapsed = Math.max(0, (Date.now() - room.startedAt) / 1000);
    const correct = current.type !== "quiz" || option === current.correct;
    const speedBonus = current.duration > 0 ? Math.max(0, Math.round((current.duration - elapsed) / current.duration * 500)) : 0;
    const points = current.type === "quiz" && correct ? 500 + speedBonus : 0;
    mutateRoom(next => { next.answers[`${next.index}:${localPlayer.id}`] = { option, correct, points }; });
    showToast("¡Respuesta enviada!");
  }));
  document.querySelector("#word-form")?.addEventListener("submit", async event => { event.preventDefault(); const liveRoom = getRoom(); if (questionIsClosed(liveRoom)) return showToast("La pregunta ya está cerrada"); const word = String(new FormData(event.currentTarget).get("word")).trim().split(/\s+/).slice(0, 2).join(" "); if (!word) return; if (liveRoom.id && window.pulseplaySupabase) { try { await submitLiveResponse({ word }); showToast("¡Palabra enviada!"); } catch (error) { showToast(error.message); } return; } mutateRoom(room => room.words.push({ word, playerId: localPlayer.id })); showToast("¡Palabra enviada!"); });
  document.querySelector("#openended-form")?.addEventListener("submit", async event => { event.preventDefault(); const liveRoom = getRoom(); if (questionIsClosed(liveRoom)) return showToast("La pregunta ya está cerrada"); const text = String(new FormData(event.currentTarget).get("text")).trim(); if (!text) return; if (liveRoom.id && window.pulseplaySupabase) { try { await submitLiveResponse({ text }); showToast("¡Respuesta enviada!"); } catch (error) { showToast(error.message); } return; } mutateRoom(room => { room.answers[`${room.index}:${localPlayer.id}`] = { text, submittedAt: Date.now(), points: 0 }; }); showToast("¡Respuesta enviada!"); });
  document.querySelector("#scale-form")?.addEventListener("submit", async event => { event.preventDefault(); const liveRoom = getRoom(); if (questionIsClosed(liveRoom)) return showToast("La pregunta ya está cerrada"); const value = Number(new FormData(event.currentTarget).get("value")); if (liveRoom.id && window.pulseplaySupabase) { try { await submitLiveResponse({ value }); showToast("¡Valoración enviada!"); } catch (error) { showToast(error.message); } return; } mutateRoom(room => { room.answers[`${room.index}:${localPlayer.id}`] = { value, submittedAt: Date.now(), points: 0 }; }); showToast("¡Valoración enviada!"); });
  document.querySelectorAll(".rank-up, .rank-down").forEach(button => button.addEventListener("click", () => { const item = button.closest(".ranking-item"); const sibling = button.classList.contains("rank-up") ? item.previousElementSibling : item.nextElementSibling; if (!sibling) return; if (button.classList.contains("rank-up")) item.parentElement.insertBefore(item, sibling); else item.parentElement.insertBefore(sibling, item); refreshRankingNumbers(); }));
  document.querySelector("#ranking-form")?.addEventListener("submit", async event => { event.preventDefault(); const liveRoom = getRoom(); if (questionIsClosed(liveRoom)) return showToast("La pregunta ya está cerrada"); const ranking = [...event.currentTarget.querySelectorAll(".ranking-item")].map(item => Number(item.dataset.option)); if (liveRoom.id && window.pulseplaySupabase) { try { await submitLiveResponse({ ranking }); showToast("¡Ranking enviado!"); } catch (error) { showToast(error.message); } return; } mutateRoom(room => { room.answers[`${room.index}:${localPlayer.id}`] = { ranking, submittedAt: Date.now(), points: 0 }; }); showToast("¡Ranking enviado!"); });
  document.querySelectorAll(".kick-player").forEach(button => button.addEventListener("click", async () => {
    const room = getRoom();
    if (room.id && window.pulseplaySupabase) {
      try { await controlLiveSession("kick", button.dataset.id); }
      catch (error) { showToast(error.message); }
      return;
    }
    mutateRoom(next => {
      next.participants = next.participants.filter(player => player.id !== button.dataset.id);
      next.blockedParticipants = [...new Set([...(next.blockedParticipants || []), button.dataset.id])];
    });
  }));
  document.querySelector("#admin-next")?.addEventListener("click", async () => {
    const liveRoom = getRoom();
    if (liveRoom.id && window.pulseplaySupabase) {
      try {
        if (liveRoom.status === "finished") await createLiveSession(liveRoom.activityId);
        else await controlLiveSession("next");
      } catch (error) { showToast(error.message); }
      return;
    }
    mutateRoom(room => {
    const questions = getQuestions(room);
    if (room.status === "lobby") { startQuestion(room, 0, questions); return; }
    if (room.status === "question") { closeQuestion(room); return; }
    if (room.status === "results") { room.status = "leaderboard"; room.endsAt = null; return; }
    if (room.status === "leaderboard") {
      if (room.index >= questions.length - 1) { room.status = "finished"; room.endsAt = null; return; }
      startQuestion(room, room.index + 1, questions);
      return;
    }
    if (room.status === "finished") { const activityId = room.activityId; Object.assign(room, roomForActivity(activityId)); }
    });
  });
  document.querySelector("#finish-and-results")?.addEventListener("click", async () => {
    const liveRoom = getRoom();
    const sessionId = liveRoom.id;
    try {
      if (sessionId && window.pulseplaySupabase && liveRoom.status !== "finished") await controlLiveSession("finish");
      else if (!sessionId) mutateRoom(room => { room.status = "finished"; room.endsAt = null; });
      await loadSessionHistory();
      navigate(sessionId ? `/results/${sessionId}` : "/results");
    } catch (error) { showToast(error.message || "No se pudo finalizar la actividad"); }
  });
  document.querySelector("#present-again")?.addEventListener("click", async () => {
    const activityId = getRoom().activityId;
    try { await createLiveSession(activityId); showToast("Nueva sala creada"); }
    catch (error) { showToast(error.message || "No se pudo crear otra sala"); }
  });
}

function refreshResultsList() {
  const container = document.querySelector("#results-list");
  if (!container) return;
  container.innerHTML = resultsListMarkup();
  bindResultsPaginationEvents();
  document.querySelectorAll("#results-list [data-nav]").forEach(el => el.addEventListener("click", () => navigateSafely(el.dataset.nav)));
}

function bindResultsPaginationEvents() {
  document.querySelector("#results-page-size")?.addEventListener("change", event => { resultsState.pageSize = Number(event.target.value); resultsState.page = 1; refreshResultsList(); });
  document.querySelector("#results-prev")?.addEventListener("click", () => { resultsState.page -= 1; refreshResultsList(); });
  document.querySelector("#results-next")?.addEventListener("click", () => { resultsState.page += 1; refreshResultsList(); });
}

function refreshLibraryResults() {
  const container = document.querySelector("#library-results");
  if (!container) return;
  container.innerHTML = libraryResultsMarkup(getOwnedActivities());
  bindLibraryResultEvents();
}

function bindLibraryResultEvents() {
  document.querySelectorAll(".edit-activity").forEach(button => button.addEventListener("click", () => navigate(`/editor/${button.dataset.id}`)));
  document.querySelectorAll(".present-activity").forEach(button => button.addEventListener("click", async () => {
    try { await createLiveSession(button.dataset.id); navigate("/admin"); }
    catch (error) { showToast(error.message || "No se pudo crear la sala"); }
  }));
  document.querySelector("#activity-page-size")?.addEventListener("change", event => { libraryState.pageSize = Number(event.target.value); libraryState.page = 1; refreshLibraryResults(); });
  document.querySelector("#page-prev")?.addEventListener("click", () => { libraryState.page -= 1; refreshLibraryResults(); });
  document.querySelector("#page-next")?.addEventListener("click", () => { libraryState.page += 1; refreshLibraryResults(); });
}

function startQuestion(room, index, questions = getQuestions(room)) {
  const now = Date.now();
  room.status = "question";
  room.index = index;
  room.reveal = false;
  room.startedAt = now;
  const duration = questions[index]?.duration ?? 20;
  room.endsAt = duration > 0 ? now + duration * 1000 : null;
}

function closeQuestion(room) {
  if (room.status !== "question") return;
  room.status = "results";
  room.reveal = true;
  room.endsAt = null;
}

async function closeExpiredQuestion() {
  const room = getRoom();
  if (room.status !== "question" || !room.endsAt || Date.now() < room.endsAt) return;
  if (room.id && window.pulseplaySupabase) {
    if (getAdmin()) {
      try { await controlLiveSession("next"); } catch (error) { console.error(error); }
    } else {
      await fetchLiveRoom();
    }
    return;
  }
  mutateRoom(closeQuestion);
}

function render() {
  clearInterval(timerHandle);
  clearInterval(liveSyncHandle);
  if (!authReady) {
    document.querySelector("#app").innerHTML = `<main class="auth-wrap"><section class="panel auth-card"><div class="eyebrow">PulsePlay</div><h2>Preparando tu espacio…</h2></section></main>`;
    return;
  }
  route = location.hash.replace("#", "") || "/";
  const room = getRoom();
  if (room.status === "question" && !room.endsAt && getQuestions(room)[room.index]?.duration > 0) {
    const current = getQuestions(room)[room.index];
    room.endsAt = (room.startedAt || Date.now()) + current.duration * 1000;
    saveRoom(room);
    return;
  }
  let view;
  if (route === "/") view = homeView();
  else if (route === "/confirmed") {
    if (location.search) history.replaceState(null, "", `${location.pathname}#/confirmed`);
    view = confirmedView();
  }
  else if (route === "/login") view = loginView();
  else if (route === "/register") view = registerView();
  else if (route === "/forgot") view = forgotView();
  else if (route.startsWith("/reset/")) view = resetView(decodeURIComponent(route.slice(7)));
  else if (route === "/reset-password") view = resetView(getAdmin()?.email || "tu cuenta");
  else if (route === "/play") view = participantView(room);
  else if (route === "/admin") view = presenterView(room);
  else if (route === "/dashboard") view = requireAdmin() ? dashboardView() : "";
  else if (route === "/results") view = requireAdmin() ? resultsView() : "";
  else if (route.startsWith("/results/")) view = requireAdmin() ? sessionResultsView(route.split("/")[2]) : "";
  else if (route === "/users") view = requireAdmin() ? usersView() : "";
  else if (route === "/profile") view = requireAdmin() ? profileView() : "";
  else if (route.startsWith("/editor/")) view = requireAdmin() ? editorView(route.split("/")[2]) : "";
  else view = homeView();
  if (view !== "") document.querySelector("#app").innerHTML = view;
  bindEvents();
  const scrollQuestionId = sessionStorage.getItem("pulseplay-scroll-question");
  if (scrollQuestionId && route.startsWith("/editor/")) {
    sessionStorage.removeItem("pulseplay-scroll-question");
    requestAnimationFrame(() => document.querySelector(`[data-question-id="${scrollQuestionId}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }
  if (room.status === "question" && room.endsAt) timerHandle = setInterval(() => {
    const liveRoom = getRoom();
    const current = getQuestions(liveRoom)[liveRoom.index];
    const remaining = Math.max(0, Math.ceil((liveRoom.endsAt - Date.now()) / 1000));
    document.querySelectorAll(".timer-fill").forEach(fill => { fill.style.width = `${remaining / current.duration * 100}%`; });
    document.querySelectorAll(".timer-number").forEach(label => { label.textContent = remaining; });
    if (remaining <= 0) closeExpiredQuestion();
  }, 250);
  if (window.pulseplaySupabase && sessionStorage.getItem(LIVE_CODE_KEY) && ["/play", "/admin"].includes(route)) {
    liveSyncHandle = setInterval(() => fetchLiveRoom(), 1000);
  }
}

window.addEventListener("hashchange", () => {
  const nextRoute = location.hash.replace("#", "") || "/";
  if (route.startsWith("/editor/") && nextRoute !== route && editorDirty) {
    if (!window.confirm("Tienes cambios sin guardar. ¿Quieres salir sin guardarlos?")) {
      location.hash = route;
      return;
    }
    editorDirty = false;
  }
  render();
});
window.addEventListener("beforeunload", event => { if (editorDirty) event.preventDefault(); });
window.addEventListener("focus", closeExpiredQuestion);
document.addEventListener("visibilitychange", () => { if (!document.hidden) closeExpiredQuestion(); });
window.addEventListener("storage", event => { if (route.startsWith("/editor/") && editorDirty) return; if ([ROOM_KEY, ACTIVITIES_KEY, USERS_KEY].includes(event.key)) render(); });
channel?.addEventListener("message", () => { if (!route.startsWith("/editor/") || !editorDirty) render(); });
if (!localStorage.getItem(ACTIVITIES_KEY)) saveActivities([defaultActivity()]);
if (!localStorage.getItem(USERS_KEY)) saveUsers(defaultUsers());
if (!localStorage.getItem(ROOM_KEY)) localStorage.setItem(ROOM_KEY, JSON.stringify(defaultRoom()));
initializeAuth().catch(error => {
  console.error("No se pudo iniciar Supabase", error);
  authReady = true;
  render();
}).then(async () => {
  await fetchLiveRoom(false);
  render();
});
