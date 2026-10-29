export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, path, handler, doc = {}) {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, path, re, keys, handler, doc });
  }

  get(p, h, d) { this.add('GET', p, h, d); }
  post(p, h, d) { this.add('POST', p, h, d); }
  put(p, h, d) { this.add('PUT', p, h, d); }
  patch(p, h, d) { this.add('PATCH', p, h, d); }
  delete(p, h, d) { this.add('DELETE', p, h, d); }

  match(method, pathname) {
    const allow = new Set(); // methods of the routes on this path (for the 405 Allow header)
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      allow.add(r.method);
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    if (allow.has('GET')) allow.add('HEAD');
    return allow.size ? { methodNotAllowed: true, allow: [...allow] } : null;
  }

  /** Minimal OpenAPI 3 document generated from the route table. */
  openapi(info) {
    const paths = {};
    for (const r of this.routes) {
      if (r.doc.hidden) continue;
      const p = r.path.replace(/:(\w+)/g, '{$1}');
      paths[p] ||= {};
      const op = {
        summary: r.doc.summary || '',
        tags: [r.doc.tag || r.path.split('/')[3] || 'misc'],
        parameters: [
          ...r.keys.map((k) => ({ name: k, in: 'path', required: true, schema: { type: k === 'id' || k === 'year' ? 'integer' : 'string' } })),
          ...Object.entries(r.doc.query || {}).map(([name, description]) => ({ name, in: 'query', required: false, description, schema: { type: 'string' } })),
        ],
        // `returns`: the response's fields, for clients (the web UI, scripts, mobile apps)
        responses: { 200: { description: r.doc.returns || 'OK' }, ...(r.doc.public ? {} : { 401: { description: 'Unauthorized' } }) },
      };
      if (r.doc.public) op.security = []; // health, login: no token needed
      // bodyType: what else the body may be (CSV imports, a ZIP upload); JSON otherwise
      if (r.doc.body) op.requestBody = { content: Object.fromEntries([r.doc.binary ? null : 'application/json', ...(r.doc.bodyType || [])].filter(Boolean).map((t) => [t, { schema: { type: t === 'application/json' ? 'object' : 'string', ...(t === 'application/zip' ? { format: 'binary' } : {}), description: r.doc.body } }])) };
      paths[p][r.method.toLowerCase()] = op;
    }
    return {
      openapi: '3.0.3',
      info,
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer', description: 'API token created in Settings → API tokens' },
          apiKey: { type: 'apiKey', in: 'query', name: 'api_key' },
        },
      },
      security: [{ bearer: [] }, { apiKey: [] }],
      paths,
    };
  }
}
