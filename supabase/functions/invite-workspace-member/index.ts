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
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Debes iniciar sesión" }, 401);

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: authData, error: authError } = await admin.auth.getUser(token);
    if (authError || !authData.user) return json({ error: "Sesión inválida" }, 401);

    const body = await request.json();
    const workspaceId = String(body.workspaceId || "");
    const email = String(body.email || "").trim().toLowerCase();
    const role = "editor";
    if (!workspaceId || !email.includes("@")) return json({ error: "Correo o espacio inválido" }, 400);
    if (email === authData.user.email?.toLowerCase()) return json({ error: "Ya perteneces a este equipo" }, 400);

    const { data: membership } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", authData.user.id)
      .maybeSingle();
    if (!membership) return json({ error: "No perteneces a este espacio" }, 403);

    const { error: invitationError } = await admin.from("workspace_invitations").upsert({
      workspace_id: workspaceId,
      email,
      role,
      invited_by: authData.user.id,
      status: "pending",
      accepted_at: null,
    }, { onConflict: "workspace_id,email" });
    if (invitationError) throw invitationError;

    let existingUser = null;
    for (let page = 1; page <= 10 && !existingUser; page += 1) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw error;
      existingUser = data.users.find((user) => user.email?.toLowerCase() === email) || null;
      if (data.users.length < 200) break;
    }

    if (existingUser) {
      const { error: membershipError } = await admin.from("workspace_members").upsert({
        workspace_id: workspaceId,
        user_id: existingUser.id,
        role,
      }, { onConflict: "workspace_id,user_id" });
      if (membershipError) throw membershipError;
      await admin.from("workspace_invitations").update({ status: "accepted", accepted_at: new Date().toISOString() })
        .eq("workspace_id", workspaceId).eq("email", email);
      return json({ status: "added", message: "El usuario fue agregado al equipo" });
    }

    const publicUrl = Deno.env.get("PUBLIC_APP_URL") || "https://migueiturra.github.io/pulseplay/";
    const redirectTo = `${publicUrl}${publicUrl.includes("?") ? "&" : "?"}invite=1`;
    const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      data: {
        full_name: email.split("@")[0],
        workspace_id: workspaceId,
        workspace_role: role,
        invited_by: authData.user.id,
      },
    });
    if (inviteError) {
      await admin.from("workspace_invitations").update({ status: "revoked" })
        .eq("workspace_id", workspaceId).eq("email", email);
      throw inviteError;
    }

    return json({ status: "invited", message: "Invitación enviada" });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "No se pudo enviar la invitación" }, 400);
  }
});
