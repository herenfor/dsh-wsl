(() => {
  const wrapSpec = (spec) => {
    if (String(spec?.id) !== '@herenfor/dsh-wsl') return spec
    const factory = spec.factory
    return { ...spec, factory: (require) => {
      let mod
      try { mod = factory(require) } catch (e) { console.error('PRE ds-bot factory threw: ' + (e?.stack ?? e)); throw e }
      const apply = mod.apply
      return { ...mod, apply: (...a) => { window.__wslctx = a[0];
        try {
          const r = apply(...a)
          if (r && typeof r.then === 'function') r.catch((e) => console.error('PRE ds-bot apply rejected: ' + (e?.stack ?? e)))
          return r
        } catch (e) { console.error('PRE ds-bot apply threw: ' + (e?.stack ?? e)); throw e }
      } }
    } }
  }
  const hookLoad = (v) => {
    let current = v.load
    Object.defineProperty(v, 'load', { configurable: true, get: () => (spec) => current.call(v, wrapSpec(spec)), set: (fn) => { current = fn } })
    if (Array.isArray(v.pendingQueue)) for (let i = 0; i < v.pendingQueue.length; i++) v.pendingQueue[i] = wrapSpec(v.pendingQueue[i])
  }
  let real
  Object.defineProperty(window, '__ModuleLoader__', { configurable: true, get() { return real }, set(v) { real = v; hookLoad(v) } })
})()
