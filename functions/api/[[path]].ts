interface Env {
  DB: D1Database;
  BOOTSTRAP_ADMIN_USERNAME?: string;
  BOOTSTRAP_ADMIN_PASSWORD?: string;
}
interface User { id: string; username: string; role: "admin" | "member"; active: number; }
const COOKIE = "mcsha_session";
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const fail = (message: string, status = 400) => json({ error: message }, status);
const uid = () => crypto.randomUUID();
const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function hashPassword(password: string, salt?: Uint8Array) {
  const actualSalt = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: actualSalt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return `${b64(actualSalt)}:${b64(new Uint8Array(bits))}`;
}
async function verifyPassword(password: string, stored: string) {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const actual = await hashPassword(password, unb64(salt));
  const a = actual.split(":")[1];
  if (a.length !== expected.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
async function digest(value: string) {
  return b64(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value))));
}
function cookieValue(request: Request) {
  const raw = request.headers.get("Cookie") ?? "";
  return raw.split(";").map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
}
async function currentUser(request: Request, env: Env): Promise<User | null> {
  const token = cookieValue(request);
  if (!token) return null;
  const row = await env.DB.prepare(`SELECT users.id, users.username, users.role, users.active
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.id_hash = ? AND sessions.expires_at > datetime('now') AND users.active = 1`)
    .bind(await digest(token)).first<User>();
  return row ?? null;
}
function sessionCookie(token: string, maxAge: number) {
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}
async function ensureBootstrapAdmin(env: Env) {
  if (!env.BOOTSTRAP_ADMIN_PASSWORD || env.BOOTSTRAP_ADMIN_PASSWORD.length < 12) return;
  const username = env.BOOTSTRAP_ADMIN_USERNAME || "admin";
  const exists = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
  if (!exists) await env.DB.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, 'admin')")
    .bind(uid(), username, await hashPassword(env.BOOTSTRAP_ADMIN_PASSWORD)).run();
}
const parse = async (request: Request) => {
  try { return await request.json() as Record<string, any>; } catch { return null; }
};
async function log(env: Env, user: User, action: string, type: string, id: string, title: string) {
  await env.DB.prepare("INSERT INTO activity_log (id,user_id,action,item_type,item_id,item_title) VALUES (?,?,?,?,?,?)")
    .bind(uid(), user.id, action, type, id, title).run();
}
export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, "");
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return new Response(null, { status: 204 });
  try {
    await ensureBootstrapAdmin(env);
    if (path === "health" && method === "GET") return json({ ok: true, app: "MC杀开发资料库" });

    if (path === "auth/login" && method === "POST") {
      const body = await parse(request);
      if (!body || typeof body.username !== "string" || typeof body.password !== "string") return fail("请输入账号和密码");
      const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND active = 1")
        .bind(body.username.trim()).first<any>();
      if (!user || !(await verifyPassword(body.password, user.password_hash))) return fail("账号或密码错误", 401);
      const token = b64(crypto.getRandomValues(new Uint8Array(32)));
      await env.DB.prepare("INSERT INTO sessions (id_hash,user_id,expires_at) VALUES (?, ?, datetime('now', '+7 days'))")
        .bind(await digest(token), user.id).run();
      return new Response(JSON.stringify({ user: { id: user.id, username: user.username, role: user.role } }), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "set-cookie": sessionCookie(token, 604800) }
      });
    }
    if (path === "auth/logout" && method === "POST") {
      const token = cookieValue(request);
      if (token) await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await digest(token)).run();
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "set-cookie": sessionCookie("", 0) } });
    }
    const user = await currentUser(request, env);
    if (path === "auth/me" && method === "GET") return user ? json({ user }) : fail("请先登录", 401);
    if (!user) return fail("请先登录", 401);

    // Modular knowledge base metadata and schema management.
    if (path === "modules" && method === "GET") {
      const result = await env.DB.prepare("SELECT * FROM modules WHERE is_enabled = 1 ORDER BY sort_order, created_at").all<any>();
      const items = await Promise.all((result.results ?? []).map(async (module: any) => {
        const [fields, categories, count] = await Promise.all([
          env.DB.prepare("SELECT id,field_key,label,field_type,required,options_json,sort_order FROM module_fields WHERE module_id=? ORDER BY sort_order").bind(module.id).all(),
          env.DB.prepare("SELECT id,name,sort_order FROM module_categories WHERE module_id=? ORDER BY sort_order,name").bind(module.id).all(),
          module.source_type === "characters"
            ? env.DB.prepare("SELECT COUNT(*) n FROM characters").first<any>()
            : module.source_type === "playbooks"
              ? env.DB.prepare("SELECT COUNT(*) n FROM playbooks").first<any>()
              : env.DB.prepare("SELECT COUNT(*) n FROM module_entries WHERE module_id=?").bind(module.id).first<any>()
        ]);
        return { ...module, fields: fields.results ?? [], categories: categories.results ?? [], entry_count: count?.n ?? 0 };
      }));
      return json({ items });
    }

    if (path === "modules" && method === "POST") {
      if (user.role !== "admin") return fail("仅管理员可以创建模块", 403);
      const b = await parse(request);
      const name = typeof b?.name === "string" ? b.name.trim() : "";
      if (name.length < 2 || name.length > 40) return fail("模块名称需为 2-40 个字符");
      const slug = typeof b?.slug === "string" && /^[a-z0-9-]{2,40}$/.test(b.slug)
        ? b.slug
        : `module-${uid().slice(0, 8)}`;
      const id = uid();
      const fields = Array.isArray(b.fields) ? b.fields.slice(0, 30) : [];
      try {
        await env.DB.prepare("INSERT INTO modules (id,name,slug,description,icon,source_type,sort_order,created_by) VALUES (?,?,?,?,?,'custom',?,?,?)")
          .bind(id, name, slug, String(b.description || "").slice(0, 500), String(b.icon || "boxes").slice(0, 40), Number(b.sort_order) || 100, user.id).run();
      } catch {
        return fail("模块名称或标识已存在，或模块创建失败", 409);
      }
      for (let i = 0; i < fields.length; i++) {
        const field = fields[i] ?? {};
        const key = typeof field.field_key === "string" ? field.field_key.trim() : "";
        const label = typeof field.label === "string" ? field.label.trim() : "";
        const type = ["text", "textarea", "number", "list"].includes(field.field_type) ? field.field_type : "text";
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key) || !label || label.length > 60) continue;
        await env.DB.prepare("INSERT OR IGNORE INTO module_fields (id,module_id,field_key,label,field_type,required,options_json,sort_order) VALUES (?,?,?,?,?,?,?,?)")
          .bind(uid(), id, key, label, type, field.required ? 1 : 0, JSON.stringify(Array.isArray(field.options) ? field.options.slice(0, 100) : []), i * 10).run();
      }
      await env.DB.prepare("INSERT OR IGNORE INTO module_categories (id,module_id,name) VALUES (?,?,?)")
        .bind(uid(), id, "未分类").run();
      await log(env, user, "创建模块", "模块", id, name);
      return json({ id }, 201);
    }

    const moduleMatch = path.match(/^modules\/([^/]+)$/);
    if (moduleMatch && method === "PUT") {
      if (user.role !== "admin") return fail("仅管理员可以修改模块设置", 403);
      const id = moduleMatch[1], b = await parse(request);
      const existing = await env.DB.prepare("SELECT * FROM modules WHERE id=?").bind(id).first<any>();
      if (!existing) return fail("模块不存在", 404);
      const name = typeof b?.name === "string" ? b.name.trim() : existing.name;
      if (name.length < 2 || name.length > 40) return fail("模块名称需为 2-40 个字符");
      const description = typeof b?.description === "string" ? b.description.slice(0, 500) : existing.description;
      const icon = typeof b?.icon === "string" ? b.icon.slice(0, 40) : existing.icon;
      const sortOrder = Number.isFinite(Number(b?.sort_order)) ? Number(b.sort_order) : existing.sort_order;
      const enabled = typeof b?.is_enabled === "boolean" ? (b.is_enabled ? 1 : 0) : existing.is_enabled;
      try {
        await env.DB.prepare("UPDATE modules SET name=?,description=?,icon=?,sort_order=?,is_enabled=?,updated_at=datetime('now') WHERE id=?")
          .bind(name, description, icon, sortOrder, enabled, id).run();
      } catch { return fail("模块设置保存失败", 409); }
      if (existing.source_type === "custom" && Array.isArray(b?.fields)) {
        const fields = b.fields.slice(0, 30);
        for (let i = 0; i < fields.length; i++) {
          const field = fields[i] ?? {};
          const key = typeof field.field_key === "string" ? field.field_key.trim() : "";
          const label = typeof field.label === "string" ? field.label.trim() : "";
          if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key) || !label || label.length > 60) continue;
          const type = ["text", "textarea", "number", "list"].includes(field.field_type) ? field.field_type : "text";
          await env.DB.prepare("INSERT INTO module_fields (id,module_id,field_key,label,field_type,required,options_json,sort_order) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(module_id,field_key) DO UPDATE SET label=excluded.label,field_type=excluded.field_type,required=excluded.required,options_json=excluded.options_json,sort_order=excluded.sort_order")
            .bind(uid(), id, key, label, type, field.required ? 1 : 0, JSON.stringify(Array.isArray(field.options) ? field.options.slice(0, 100) : []), i * 10).run();
        }
      }
      await log(env, user, "修改模块", "模块", id, name);
      return json({ ok: true });
    }

    const categoryCollection = path.match(/^modules\/([^/]+)\/categories$/);
    if (categoryCollection && method === "POST") {
      if (user.role !== "admin") return fail("仅管理员可以管理模块分类", 403);
      const moduleId = categoryCollection[1], b = await parse(request);
      const name = typeof b?.name === "string" ? b.name.trim() : "";
      if (!name || name.length > 50) return fail("分类名称需为 1-50 个字符");
      const module = await env.DB.prepare("SELECT id FROM modules WHERE id=?").bind(moduleId).first();
      if (!module) return fail("模块不存在", 404);
      const id = uid();
      try {
        await env.DB.prepare("INSERT INTO module_categories (id,module_id,name,sort_order) VALUES (?,?,?,?)")
          .bind(id, moduleId, name, Number(b.sort_order) || 0).run();
      } catch { return fail("该分类已存在", 409); }
      return json({ id, name }, 201);
    }

    const categoryItem = path.match(/^modules\/([^/]+)\/categories\/([^/]+)$/);
    if (categoryItem && method === "DELETE") {
      if (user.role !== "admin") return fail("仅管理员可以管理模块分类", 403);
      const [moduleId, categoryId] = [categoryItem[1], categoryItem[2]];
      const category = await env.DB.prepare("SELECT name FROM module_categories WHERE id=? AND module_id=?").bind(categoryId, moduleId).first<any>();
      if (!category) return fail("分类不存在", 404);
      const module = await env.DB.prepare("SELECT source_type FROM modules WHERE id=?").bind(moduleId).first<any>();
      const used = module?.source_type === "characters"
        ? await env.DB.prepare("SELECT COUNT(*) n FROM characters WHERE category=?").bind(category.name).first<any>()
        : module?.source_type === "playbooks"
          ? await env.DB.prepare("SELECT COUNT(*) n FROM playbooks WHERE category=?").bind(category.name).first<any>()
          : await env.DB.prepare("SELECT COUNT(*) n FROM module_entries WHERE module_id=? AND category=?").bind(moduleId, category.name).first<any>();
      if ((used?.n ?? 0) > 0) return fail("该分类仍被资料使用，请先调整相关资料的分类", 409);
      await env.DB.prepare("DELETE FROM module_categories WHERE id=? AND module_id=?").bind(categoryId, moduleId).run();
      return json({ ok: true });
    }

    const moduleEntries = path.match(/^modules\/([^/]+)\/entries$/);
    if (moduleEntries && method === "GET") {
      const moduleId = moduleEntries[1];
      const module = await env.DB.prepare("SELECT * FROM modules WHERE id=? AND is_enabled=1").bind(moduleId).first<any>();
      if (!module) return fail("模块不存在或已停用", 404);
      if (module.source_type === "characters") {
        const result = await env.DB.prepare("SELECT c.*, creator.username AS creator_name, (SELECT COUNT(*) FROM character_versions v WHERE v.character_id=c.id) AS version_count FROM characters c JOIN users creator ON creator.id=c.created_by ORDER BY c.updated_at DESC").all<any>();
        const items = await Promise.all((result.results ?? []).map(async (c: any) => {
          const traits = await env.DB.prepare("SELECT id,name,effect,introduction FROM traits WHERE character_id=? ORDER BY sort_order,id").bind(c.id).all();
          return { ...c, title: c.name, content: { name: c.name, health: c.health, description: c.description, traits: traits.results ?? [] } };
        }));
        return json({ items });
      }
      if (module.source_type === "playbooks") {
        const result = await env.DB.prepare("SELECT p.*, creator.username AS creator_name, (SELECT COUNT(*) FROM playbook_versions v WHERE v.playbook_id=p.id) AS version_count FROM playbooks p JOIN users creator ON creator.id=p.created_by ORDER BY p.updated_at DESC").all<any>();
        return json({ items: (result.results ?? []).map((p: any) => ({ ...p, title: p.title, content: { title: p.title, summary: p.summary, steps: JSON.parse(p.steps_json || "[]"), notes: p.notes } })) });
      }
      const result = await env.DB.prepare("SELECT e.*, creator.username AS creator_name, editor.username AS editor_name, (SELECT COUNT(*) FROM module_entry_versions v WHERE v.entry_id=e.id) AS version_count FROM module_entries e JOIN users creator ON creator.id=e.created_by LEFT JOIN users editor ON editor.id=e.updated_by WHERE e.module_id=? ORDER BY e.updated_at DESC")
        .bind(moduleId).all<any>();
      return json({ items: (result.results ?? []).map((entry: any) => ({ ...entry, content: JSON.parse(entry.content_json || "{}") })) });
    }

    if (moduleEntries && method === "POST") {
      const moduleId = moduleEntries[1], b = await parse(request);
      const module = await env.DB.prepare("SELECT * FROM modules WHERE id=? AND is_enabled=1").bind(moduleId).first<any>();
      if (!module) return fail("模块不存在或已停用", 404);
      if (module.source_type !== "custom") return fail("该模块使用专用编辑器，请从对应资料页面创建", 400);
      const title = typeof b?.title === "string" ? b.title.trim() : "";
      if (!title || title.length > 160) return fail("资料标题需为 1-160 个字符");
      const content = b?.content && typeof b.content === "object" && !Array.isArray(b.content) ? b.content : {};
      const fieldResult = await env.DB.prepare("SELECT field_key,label,field_type,required FROM module_fields WHERE module_id=?").bind(moduleId).all<any>();
      for (const field of fieldResult.results ?? []) {
        const value = content[field.field_key];
        if (field.required && (value === undefined || value === null || String(value).trim() === "")) return fail(`请填写必填字段：${field.label}`);
      }
      const id = uid(), category = String(b.category || "未分类").slice(0, 50);
      const snapshot = { title, category, content };
      await env.DB.prepare("INSERT INTO module_entries (id,module_id,title,category,content_json,created_by,updated_by) VALUES (?,?,?,?,?,?,?)")
        .bind(id, moduleId, title, category, JSON.stringify(content), user.id, user.id).run();
      await env.DB.prepare("INSERT INTO module_entry_versions (id,entry_id,version_number,snapshot_json,editor_id,edit_note) VALUES (?,?,1,?,?,?)")
        .bind(uid(), id, JSON.stringify(snapshot), user.id, String(b.edit_note || "创建资料").slice(0, 300)).run();
      await log(env, user, "创建", "资料", id, title);
      return json({ id }, 201);
    }

    const moduleEntryItem = path.match(/^modules\/([^/]+)\/entries\/([^/]+)$/);
    if (moduleEntryItem && method === "PUT") {
      const [moduleId, entryId] = [moduleEntryItem[1], moduleEntryItem[2]], b = await parse(request);
      const module = await env.DB.prepare("SELECT source_type FROM modules WHERE id=? AND is_enabled=1").bind(moduleId).first<any>();
      if (!module || module.source_type !== "custom") return fail("仅支持编辑自定义模块中的资料", 400);
      const old = await env.DB.prepare("SELECT * FROM module_entries WHERE id=? AND module_id=?").bind(entryId, moduleId).first<any>();
      if (!old) return fail("资料不存在", 404);
      const title = typeof b?.title === "string" ? b.title.trim() : old.title;
      if (!title || title.length > 160) return fail("资料标题需为 1-160 个字符");
      const content = b?.content && typeof b.content === "object" && !Array.isArray(b.content) ? b.content : JSON.parse(old.content_json || "{}");
      const fieldResult = await env.DB.prepare("SELECT field_key,label,required FROM module_fields WHERE module_id=?").bind(moduleId).all<any>();
      for (const field of fieldResult.results ?? []) {
        const value = content[field.field_key];
        if (field.required && (value === undefined || value === null || String(value).trim() === "")) return fail(`请填写必填字段：${field.label}`);
      }
      const category = String(b?.category ?? old.category).slice(0, 50);
      const next = await env.DB.prepare("SELECT COALESCE(MAX(version_number),0)+1 n FROM module_entry_versions WHERE entry_id=?").bind(entryId).first<any>();
      const snapshot = { title, category, content };
      await env.DB.prepare("UPDATE module_entries SET title=?,category=?,content_json=?,updated_by=?,updated_at=datetime('now') WHERE id=?")
        .bind(title, category, JSON.stringify(content), user.id, entryId).run();
      await env.DB.prepare("INSERT INTO module_entry_versions (id,entry_id,version_number,snapshot_json,editor_id,edit_note) VALUES (?,?,?,?,?,?)")
        .bind(uid(), entryId, next?.n ?? 1, JSON.stringify(snapshot), user.id, String(b?.edit_note || "更新资料").slice(0, 300)).run();
      await log(env, user, "编辑", "资料", entryId, title);
      return json({ ok: true });
    }

    if (path === "dashboard" && method === "GET") {
      const [characters, playbooks, users, recent] = await Promise.all([
        env.DB.prepare("SELECT COUNT(*) n FROM characters").first<any>(),
        env.DB.prepare("SELECT COUNT(*) n FROM playbooks").first<any>(),
        env.DB.prepare("SELECT COUNT(*) n FROM users WHERE active=1").first<any>(),
        env.DB.prepare(`SELECT a.id,a.action,a.item_type,a.item_title,a.created_at,u.username
          FROM activity_log a JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 8`).all()
      ]);
      return json({ characters: characters?.n ?? 0, playbooks: playbooks?.n ?? 0, users: users?.n ?? 0, recent: recent.results });
    }
    if (path === "characters" && method === "GET") {
      const result = await env.DB.prepare(`SELECT c.*, creator.username AS creator_name, editor.username AS editor_name,
        (SELECT COUNT(*) FROM character_versions v WHERE v.character_id=c.id) AS version_count
        FROM characters c JOIN users creator ON creator.id=c.created_by
        LEFT JOIN character_versions latest ON latest.id=(SELECT id FROM character_versions WHERE character_id=c.id ORDER BY version_number DESC LIMIT 1)
        LEFT JOIN users editor ON editor.id=latest.edited_by ORDER BY c.updated_at DESC`).all<any>();
      const list = await Promise.all((result.results ?? []).map(async (c: any) => {
        const traits = await env.DB.prepare("SELECT id,name,effect,introduction FROM traits WHERE character_id=? ORDER BY sort_order,id").bind(c.id).all();
        return { ...c, traits: traits.results ?? [] };
      }));
      return json({ items: list });
    }
    if (path === "characters" && method === "POST") {
      const b = await parse(request);
      if (!b || typeof b.name !== "string" || !b.name.trim()) return fail("角色名称不能为空");
      const id = uid(), name = b.name.trim();
      const snapshot = { name, health: Math.max(0, Math.min(999, Number(b.health) || 4)), category: String(b.category || "未分类"), description: String(b.description || ""), traits: Array.isArray(b.traits) ? b.traits.slice(0, 30) : [] };
      await env.DB.prepare("INSERT INTO characters (id,name,health,category,description,created_by) VALUES (?,?,?,?,?,?)").bind(id, snapshot.name, snapshot.health, snapshot.category, snapshot.description, user.id).run();
      for (let i=0;i<snapshot.traits.length;i++) {
        const t = snapshot.traits[i] ?? {};
        await env.DB.prepare("INSERT INTO traits (id,character_id,name,effect,introduction,sort_order) VALUES (?,?,?,?,?,?)")
          .bind(uid(), id, String(t.name || "未命名词条"), String(t.effect || ""), String(t.introduction || ""), i).run();
      }
      await env.DB.prepare("INSERT INTO character_versions (id,character_id,version_number,snapshot_json,edited_by,edit_note) VALUES (?,?,1,?,?,?)")
        .bind(uid(), id, JSON.stringify(snapshot), user.id, String(b.editNote || "创建角色")).run();
      await log(env,user,"创建","角色",id,name);
      return json({ id }, 201);
    }
    const charMatch = path.match(/^characters\/([^/]+)$/);
    if (charMatch && method === "PUT") {
      const id = charMatch[1], b = await parse(request);
      if (!b || typeof b.name !== "string" || !b.name.trim()) return fail("角色名称不能为空");
      const old = await env.DB.prepare("SELECT * FROM characters WHERE id=?").bind(id).first<any>();
      if (!old) return fail("角色不存在",404);
      const traits = Array.isArray(b.traits) ? b.traits.slice(0,30) : [];
      const snapshot = { name:b.name.trim(), health:Math.max(0,Math.min(999,Number(b.health)||4)), category:String(b.category||"未分类"), description:String(b.description||""), traits };
      const next = await env.DB.prepare("SELECT COALESCE(MAX(version_number),0)+1 n FROM character_versions WHERE character_id=?").bind(id).first<any>();
      await env.DB.prepare("UPDATE characters SET name=?,health=?,category=?,description=?,updated_at=datetime('now') WHERE id=?").bind(snapshot.name,snapshot.health,snapshot.category,snapshot.description,id).run();
      await env.DB.prepare("DELETE FROM traits WHERE character_id=?").bind(id).run();
      for (let i=0;i<traits.length;i++) { const t=traits[i]??{}; await env.DB.prepare("INSERT INTO traits (id,character_id,name,effect,introduction,sort_order) VALUES (?,?,?,?,?,?)").bind(uid(),id,String(t.name||"未命名词条"),String(t.effect||""),String(t.introduction||""),i).run(); }
      await env.DB.prepare("INSERT INTO character_versions (id,character_id,version_number,snapshot_json,edited_by,edit_note) VALUES (?,?,?,?,?,?)")
        .bind(uid(),id,next?.n??1,JSON.stringify(snapshot),user.id,String(b.editNote||"更新角色资料")).run();
      await log(env,user,"编辑","角色",id,snapshot.name);
      return json({ ok:true });
    }
    const versionsMatch = path.match(/^characters\/([^/]+)\/versions$/);
    if (versionsMatch && method === "GET") {
      const r = await env.DB.prepare(`SELECT v.id,v.version_number,v.snapshot_json,v.edit_note,v.created_at,u.username AS editor_name
        FROM character_versions v JOIN users u ON u.id=v.edited_by WHERE v.character_id=? ORDER BY v.version_number DESC`).bind(versionsMatch[1]).all();
      return json({ items:r.results });
    }
    if (path === "playbooks" && method === "GET") {
      const r = await env.DB.prepare(`SELECT p.*, c.username AS creator_name, u.username AS editor_name,
        (SELECT COUNT(*) FROM playbook_versions v WHERE v.playbook_id=p.id) AS version_count
        FROM playbooks p JOIN users c ON c.id=p.created_by
        LEFT JOIN playbook_versions v ON v.id=(SELECT id FROM playbook_versions WHERE playbook_id=p.id ORDER BY version_number DESC LIMIT 1)
        LEFT JOIN users u ON u.id=v.edited_by ORDER BY p.updated_at DESC`).all<any>();
      return json({ items:(r.results??[]).map((p:any)=>({...p,steps:JSON.parse(p.steps_json||"[]")})) });
    }
    if (path === "playbooks" && method === "POST") {
      const b=await parse(request); if(!b||typeof b.title!=="string"||!b.title.trim()) return fail("玩法名称不能为空");
      const id=uid(), snap={title:b.title.trim(),category:String(b.category||"未分类"),summary:String(b.summary||""),steps:Array.isArray(b.steps)?b.steps.slice(0,60):[],notes:String(b.notes||"")};
      await env.DB.prepare("INSERT INTO playbooks (id,title,category,summary,steps_json,notes,created_by) VALUES (?,?,?,?,?,?,?)").bind(id,snap.title,snap.category,snap.summary,JSON.stringify(snap.steps),snap.notes,user.id).run();
      await env.DB.prepare("INSERT INTO playbook_versions (id,playbook_id,version_number,snapshot_json,edited_by,edit_note) VALUES (?,?,1,?,?,?)").bind(uid(),id,JSON.stringify(snap),user.id,String(b.editNote||"创建玩法流程")).run();
      await log(env,user,"创建","玩法",id,snap.title); return json({id},201);
    }
    const playMatch=path.match(/^playbooks\/([^/]+)$/);
    if(playMatch&&method==="PUT"){
      const id=playMatch[1],b=await parse(request); if(!b||typeof b.title!=="string"||!b.title.trim()) return fail("玩法名称不能为空");
      const old=await env.DB.prepare("SELECT id FROM playbooks WHERE id=?").bind(id).first(); if(!old) return fail("玩法不存在",404);
      const snap={title:b.title.trim(),category:String(b.category||"未分类"),summary:String(b.summary||""),steps:Array.isArray(b.steps)?b.steps.slice(0,60):[],notes:String(b.notes||"")};
      const next=await env.DB.prepare("SELECT COALESCE(MAX(version_number),0)+1 n FROM playbook_versions WHERE playbook_id=?").bind(id).first<any>();
      await env.DB.prepare("UPDATE playbooks SET title=?,category=?,summary=?,steps_json=?,notes=?,updated_at=datetime('now') WHERE id=?").bind(snap.title,snap.category,snap.summary,JSON.stringify(snap.steps),snap.notes,id).run();
      await env.DB.prepare("INSERT INTO playbook_versions (id,playbook_id,version_number,snapshot_json,edited_by,edit_note) VALUES (?,?,?,?,?,?)").bind(uid(),id,next?.n??1,JSON.stringify(snap),user.id,String(b.editNote||"更新玩法流程")).run();
      await log(env,user,"编辑","玩法",id,snap.title); return json({ok:true});
    }
    const pbVersions=path.match(/^playbooks\/([^/]+)\/versions$/);
    if(pbVersions&&method==="GET"){
      const r=await env.DB.prepare(`SELECT v.id,v.version_number,v.snapshot_json,v.edit_note,v.created_at,u.username AS editor_name FROM playbook_versions v JOIN users u ON u.id=v.edited_by WHERE v.playbook_id=? ORDER BY v.version_number DESC`).bind(pbVersions[1]).all();
      return json({items:r.results});
    }
    if (path === "admin/users" && method === "GET") {
      if(user.role!=="admin") return fail("仅管理员可管理账号",403);
      const r=await env.DB.prepare("SELECT id,username,role,active,created_at FROM users ORDER BY created_at DESC").all(); return json({items:r.results});
    }
    if (path === "admin/users" && method === "POST") {
      if(user.role!=="admin") return fail("仅管理员可创建账号",403);
      const b=await parse(request);
      if(!b||typeof b.username!=="string"||typeof b.password!=="string") return fail("请填写账号和密码");
      const username=b.username.trim();
      if(!/^[a-zA-Z0-9_-]{3,24}$/.test(username)) return fail("账号需为 3-24 位字母、数字、下划线或连字符");
      if(b.password.length<12||b.password.length>128) return fail("密码长度须为 12-128 位");
      try { await env.DB.prepare("INSERT INTO users (id,username,password_hash,role) VALUES (?,?,?,'member')").bind(uid(),username,await hashPassword(b.password)).run(); }
      catch { return fail("账号已存在或创建失败",409); }
      await log(env,user,"创建账号","账号",username,username); return json({ok:true},201);
    }
    const userMatch=path.match(/^admin\/users\/([^/]+)\/(disable|enable|reset-password)$/);
    if(userMatch&&method==="POST"){
      if(user.role!=="admin") return fail("仅管理员可管理账号",403);
      const target=userMatch[1],action=userMatch[2],b=await parse(request);
      if(target===user.id&&action==="disable") return fail("不能停用当前登录的管理员账号");
      const found=await env.DB.prepare("SELECT id FROM users WHERE id=?").bind(target).first(); if(!found) return fail("账号不存在",404);
      if(action==="disable"||action==="enable"){
        await env.DB.prepare("UPDATE users SET active=? WHERE id=?").bind(action==="enable"?1:0,target).run();
        if(action==="disable") await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(target).run();
      } else {
        if(typeof b?.password!=="string"||b.password.length<12||b.password.length>128) return fail("新密码长度须为 12-128 位");
        await env.DB.prepare("UPDATE users SET password_hash=? WHERE id=?").bind(await hashPassword(b.password),target).run();
        await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(target).run();
      }
      return json({ok:true});
    }
    return fail("接口不存在",404);
  } catch (error) {
    console.error("API error", error);
    return fail("服务器处理请求时发生错误，请检查 Cloudflare 日志",500);
  }
};