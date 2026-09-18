/**
 * roles — the auth-role flags the participant holds and which screens those roles open.
 *
 * Reads: profile_data.role_ref -> users_roles (boolean flags) · eisroles (specialist role, if any) ·
 * dashboard (route ACL: docs with route/roles[]/profileid[]/label, nested in children[] — exactly what
 * AuthguardService.routeConfig() evaluates in the web app).
 */
const { C, docsOf, docById, getAllByRef } = require("../collection");
const {
  withFilter, envelope, emptyEnvelope, parseOptions, refId, refPath, plural,
} = require("../envelope");

const ROLE_PRIORITY = ["admin", "developer", "ah", "operator", "floor", "coordinator", "mentor", "eis", "changeagent", "big_provider", "big_participant", "participant"];

/** dashboard docs -> flat [{ path, label, roles[], profileid[], dashboardNode }] */
function flattenDashboard(docs) {
  const out = [];
  for (const d of docs || []) {
    const children = Array.isArray(d.children) ? d.children : [];
    if (!children.length) {
      if (d.route) out.push({ path: d.route, label: d.label ?? null, roles: d.roles || [], profileid: d.profileid || [], dashboardNode: d.id });
    } else {
      for (const c of children) if (c?.route) out.push({ path: c.route, label: c.label ?? null, roles: c.roles || [], profileid: c.profileid || [], dashboardNode: d.id });
    }
  }
  return out;
}

/** Pure projection. raw = { profile, roles (users_roles doc), eisrole, dashboard[] } */
function project(raw, opts = {}) {
  const { now } = parseOptions(opts);
  const includeDenied = opts.includeDenied === true || String(opts.includeDenied) === "true";
  const flags = Object.fromEntries(Object.entries(raw.roles || {}).filter(([k, v]) => typeof v === "boolean" && !["id", "_path"].includes(k)));
  const granted = Object.keys(flags).filter((k) => flags[k] === true);
  const primary = ROLE_PRIORITY.find((r) => granted.includes(r)) || granted[0] || null;
  const profileid = raw.profile?.profileid ?? raw.profile?.id ?? null;
  const routes = flattenDashboard(raw.dashboard).map((r) => {
    const byRole = r.roles.find((x) => granted.includes(x)) || null;
    const byProfile = profileid != null && r.profileid.map(refId).includes(profileid);
    const open = r.roles.length === 0 && r.profileid.length === 0;
    const allowed = !!byRole || byProfile || open;
    return { path: r.path.startsWith("/") ? r.path : "/" + r.path, component: r.label, allowed, grantedBy: byRole ? "roles[]" : byProfile ? "profileid[]" : open ? "unrestricted" : null, roleUsed: byRole, restriction: null, dashboardNode: r.dashboardNode };
  }).sort((a, b) => (a.allowed === b.allowed ? a.path.localeCompare(b.path) : a.allowed ? -1 : 1));
  const allowed = routes.filter((r) => r.allowed);
  const items = includeDenied ? routes : allowed;
  const eis = raw.eisrole ? { role: raw.eisrole.role ?? null, experiencestage: raw.eisrole.experiencestage ?? null, experiencelevel: raw.eisrole.experiencelevel ?? null } : null;
  return envelope({
    now,
    summary: {
      headline: granted.length ? `Roles: ${granted.join(", ")} (primary ${primary}) · ${allowed.length} of ${routes.length} dashboard screens allowed` + (eis ? ` · specialist ${eis.role}` : "") : "No auth roles on record for this profile.",
      uid: refId(raw.profile?.user_ref), role_ref: refPath(raw.profile?.role_ref), primaryRole: primary, roles: flags, eisrole: eis,
      screensAllowed: allowed.length, screensTotal: routes.length, includeDenied,
    },
    counts: { total: items.length, allowed: allowed.length, denied: routes.length - allowed.length, rolesGranted: granted.length, dashboardNodes: new Set(routes.map((r) => r.dashboardNode)).size },
    items,
  });
}

async function load(profileid, opts = {}) {
  const profile = await docById(C.PROFILE, profileid);
  if (!profile) return emptyEnvelope("No profile on record for this profileid.", parseOptions(opts).now);
  const [refDocs, dashboard, eis] = await Promise.all([
    getAllByRef([profile.role_ref].filter(Boolean)),
    docsOf(C.DASHBOARD),
    docsOf(C.EIS_ROLES, (c) => c.where("profileid", "==", profileid).limit(1)).catch(() => []),
  ]);
  const roles = profile.role_ref ? refDocs.get(refPath(profile.role_ref)) : null;
  return project({ profile, roles, eisrole: eis[0] || null, dashboard }, opts);
}

module.exports = Object.freeze({
  name: "roles",
  description: "Which auth roles the participant holds (users_roles flags) and which dashboard screens those roles open, with the rule that grants each one. includeDenied=true lists blocked screens too.",
  input_schema: withFilter("includeDenied", { type: "boolean" }),
  sources: [C.PROFILE.name, C.USERS_ROLES.name, C.EIS_ROLES.name, C.DASHBOARD.name],
  handler: (input, ctx = {}) => load(input.profileid, { ...input, now: ctx.now }),
  load, project, flattenDashboard,
});
