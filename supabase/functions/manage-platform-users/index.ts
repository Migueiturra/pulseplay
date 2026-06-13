import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Método no permitido" }, 405);

  try {
    const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Debes iniciar sesión" }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: authData, error: authError } = await admin.auth.getUser(token);
    if (authError || !authData.user) return json({ error: "Sesión inválida" }, 401);

    const { data: caller } = await admin.from("profiles")
      .select("platform_role, account_status")
      .eq("id", authData.user.id)
      .maybeSingle();
    if (caller?.platform_role !== "super_admin" || caller.account_status !== "active") {
      return json({ error: "No tienes permisos de administración de plataforma" }, 403);
    }

    const body = await request.json();
    const action = String(body.action || "list");

    if (action === "list") {
      const { data: profiles, error: profilesError } = await admin.from("profiles")
        .select("id, name, email, platform_role, account_status, created_at")
        .order("created_at", { ascending: false });
      if (profilesError) throw profilesError;

      const authUsers = [];
      for (let page = 1; page <= 10; page += 1) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
        if (error) throw error;
        authUsers.push(...data.users);
        if (data.users.length < 200) break;
      }
      const authMap = new Map(authUsers.map((user) => [user.id, user]));
      return json({ users: (profiles || []).map((profile) => {
        const user = authMap.get(profile.id);
        return {
          ...profile,
          provider: user?.app_metadata?.provider || "email",
          lastSignInAt: user?.last_sign_in_at || null,
          emailConfirmedAt: user?.email_confirmed_at || null,
        };
      }) });
    }

    if (action === "invite") {
      const email = String(body.email || "").trim().toLowerCase();
      if (!email || !email.includes("@")) return json({ error: "Ingresa un correo válido" }, 400);
      const publicUrl = Deno.env.get("PUBLIC_APP_URL") || "https://migueiturra.github.io/pulseplay/";
      const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
        redirectTo: `${publicUrl}${publicUrl.includes("?") ? "&" : "?"}invite=1`,
      });
      if (inviteError) throw inviteError;
      return json({ message: `Invitación enviada a ${email}` });
    }

    const userId = String(body.userId || "");
    if (!userId || userId === authData.user.id) return json({ error: "No puedes modificar tu propia cuenta" }, 400);
    const { data: target } = await admin.from("profiles").select("platform_role").eq("id", userId).maybeSingle();
    if (!target) return json({ error: "Usuario no encontrado" }, 404);
    if (target.platform_role === "super_admin") return json({ error: "No puedes modificar otro superadministrador" }, 403);

    if (action === "suspend" || action === "activate") {
      const suspended = action === "suspend";
      const { error: authUpdateError } = await admin.auth.admin.updateUserById(userId, {
        ban_duration: suspended ? "876000h" : "none",
      });
      if (authUpdateError) throw authUpdateError;
      const { error: profileUpdateError } = await admin.from("profiles")
        .update({ account_status: suspended ? "suspended" : "active" })
        .eq("id", userId);
      if (profileUpdateError) throw profileUpdateError;
      return json({ message: suspended ? "Cuenta suspendida" : "Cuenta reactivada" });
    }

    if (action === "delete") {
      const { data: ownedWorkspaces, error: workspacesError } = await admin.from("workspaces")
        .select("id")
        .eq("created_by", userId);
      if (workspacesError) throw workspacesError;
      if (ownedWorkspaces?.length) {
        const { error: deleteWorkspacesError } = await admin.from("workspaces")
          .delete()
          .in("id", ownedWorkspaces.map((workspace) => workspace.id));
        if (deleteWorkspacesError) throw deleteWorkspacesError;
      }

      const { data: remainingActivities, error: activitiesError } = await admin.from("activities")
        .select("id, workspace_id")
        .eq("created_by", userId);
      if (activitiesError) throw activitiesError;
      const { data: remainingSessions, error: sessionsError } = await admin.from("live_sessions")
        .select("id, workspace_id")
        .eq("host_id", userId);
      if (sessionsError) throw sessionsError;

      const workspaceIds = [...new Set([
        ...(remainingActivities || []).map((item) => item.workspace_id),
        ...(remainingSessions || []).map((item) => item.workspace_id),
      ])];
      if (workspaceIds.length) {
        const { data: workspaces, error: ownersError } = await admin.from("workspaces")
          .select("id, created_by")
          .in("id", workspaceIds);
        if (ownersError) throw ownersError;
        for (const workspace of workspaces || []) {
          const activityIds = (remainingActivities || []).filter((item) => item.workspace_id === workspace.id).map((item) => item.id);
          if (activityIds.length) {
            const { error } = await admin.from("activities").update({ created_by: workspace.created_by }).in("id", activityIds);
            if (error) throw error;
          }
          const sessionIds = (remainingSessions || []).filter((item) => item.workspace_id === workspace.id).map((item) => item.id);
          if (sessionIds.length) {
            const { error } = await admin.from("live_sessions").update({ host_id: workspace.created_by }).in("id", sessionIds);
            if (error) throw error;
          }
        }
      }

      const { error: invitationsError } = await admin.from("workspace_invitations").delete().eq("invited_by", userId);
      if (invitationsError) throw invitationsError;
      const { error: deleteUserError } = await admin.auth.admin.deleteUser(userId);
      if (deleteUserError) throw deleteUserError;
      return json({ message: "Cuenta eliminada definitivamente" });
    }

    return json({ error: "Acción no válida" }, 400);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "No se pudo administrar la cuenta" }, 400);
  }
});
