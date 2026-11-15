// Servidor real (Deno.serve original) que despacha a cada función por ruta
const originalServe = Deno.serve.bind(Deno);
const handlers: Record<string, (req: Request) => Response | Promise<Response>> = {};
let actual = '';
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (h: any) => { handlers[actual] = typeof h === 'function' ? h : h.handler; return { finished: Promise.resolve() }; };
for (const nombre of ['whatsapp-webhook', 'enviar', 'push', 'media', 'admin-usuarios', 'simular']) {
  actual = nombre;
  await import(`../supabase/functions/${nombre}/index.ts`);
}
originalServe({ port: Number(Deno.env.get('FN_PORT') || 54400), onListen: () => console.log('edge functions listas') }, (req) => {
  const nombre = new URL(req.url).pathname.split('/')[1];
  const h = handlers[nombre];
  return h ? h(req) : new Response('no existe', { status: 404 });
});
