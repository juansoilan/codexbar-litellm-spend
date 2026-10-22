defineProvider({
  id: "litellm-spend",
  name: "LiteLLM Spend",
  icon: { monogram: "LS", tint: "#2160C4" },
  endpoints: [
    { setting: "BASE_URL", policy: "https-or-private-network-http" },
    "https://api.frankfurter.dev",
  ],
  settings: [
    {
      key: "BASE_URL",
      title: "Base URL",
      subtitle: "LiteLLM proxy origin (no /v1)",
      type: "plain",
    },
    // plain: user plugins that set Authorization per key need this (secure → 401).
    { key: "LABEL_1", title: "Account 1 label", type: "plain" },
    { key: "KEY_1", title: "Account 1 API key", type: "plain" },
    { key: "LABEL_2", title: "Account 2 label", type: "plain" },
    { key: "KEY_2", title: "Account 2 API key", type: "plain" },
    { key: "LABEL_3", title: "Account 3 label", type: "plain" },
    {
      key: "KEY_3",
      title: "Account 3 API key",
      subtitle: "Up to 3 accounts. Labels optional; empty uses LiteLLM alias.",
      type: "plain",
    },
  ],
  capabilities: ["http-status", "persistent-storage"],
  async fetchUsage(ctx) {
    const [basePath] = String(ctx.settings.get("BASE_URL") || "").trim().split(/(?=[?#])/u, 2);
    let origin = basePath.replace(/\/+$/u, "");
    if (decodeURIComponent(origin).endsWith("/v1")) {
      origin = origin.slice(0, origin.lastIndexOf("/"));
    }
    if (!origin) throw ctx.fail.missingCredential("Set the LiteLLM Base URL");

    const keys = [];
    const seen = new Set();
    for (let slot = 1; slot <= 3; slot += 1) {
      const key = String(ctx.settings.get(`KEY_${slot}`) || "")
        .trim()
        .replace(/^['"]|['"]$/gu, "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const label = String(ctx.settings.get(`LABEL_${slot}`) || "").trim();
      keys.push({ label, key });
    }
    if (!keys.length) throw ctx.fail.missingCredential("Add at least one LiteLLM API key");

    const now = ctx.date.now();
    const end = now.toISOString().slice(0, 10);
    const monthStart = `${end.slice(0, 8)}01`;
    const isoDaysAgo = (days) => new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
    const start30 = isoDaysAgo(29);
    const start7 = isoDaysAgo(6);
    const readSavedRate = () => {
      try {
        const saved = ctx.storage.get("usdEur");
        if (!saved) return null;
        const parsed = JSON.parse(saved);
        const rate = Number(parsed && parsed.rate);
        const date = parsed && typeof parsed.date === "string" ? parsed.date : "";
        if (!Number.isFinite(rate) || rate < 0.5 || rate > 1.5) return null;
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return null;
        return { rate, date };
      } catch (error) {
        void error;
        return null;
      }
    };
    const loadRate = async () => {
      let response;
      try {
        response = await ctx.http.getJSON(
          "https://api.frankfurter.dev/v1/latest?from=USD&to=EUR",
          { timeoutSeconds: 8 },
        );
      } catch (error) {
        void error;
        return readSavedRate();
      }
      const payload = response && response.json;
      const rate = payload && payload.rates ? Number(payload.rates.EUR) : NaN;
      const date = payload && typeof payload.date === "string" ? payload.date : "";
      const fresh =
        response.status === 200 &&
        payload &&
        payload.base === "USD" &&
        Number.isFinite(rate) &&
        rate >= 0.5 &&
        rate <= 1.5 &&
        /^\d{4}-\d{2}-\d{2}$/u.test(date);
      if (!fresh) return readSavedRate();
      try {
        ctx.storage.set("usdEur", JSON.stringify({ rate, date }));
      } catch (error) {
        void error;
      }
      return { rate, date };
    };
    const fx = await loadRate();
    const load = async (key, path) => {
      let response;
      try {
        response = await ctx.http.get(`${origin}${path}`, {
          headers: { Authorization: `Bearer ${key}` },
          timeoutSeconds: 12,
        });
      } catch (error) {
        void error;
        return { error: "network" };
      }
      if (response.status === 401) return { error: "rejected" };
      if (response.status === 403) return { error: "denied" };
      if (response.status < 200 || response.status >= 300) return { error: `HTTP ${response.status}` };
      try {
        return { json: JSON.parse(response.bodyText) };
      } catch (error) {
        void error;
        return { error: "invalid JSON" };
      }
    };
    const money = (value) => {
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : 0;
    };
    const labelFor = (preferred, info, index, used) => {
      const alias =
        info && [info.key_alias, info.key_name].find((value) => typeof value === "string" && value.trim());
      let label = (preferred || (alias ? alias.trim() : "") || `Line ${index + 1}`).slice(0, 48);
      if (!ctx.isDetailLabel(label)) label = `Line ${index + 1}`;
      let unique = label;
      let suffix = 2;
      while (used.has(unique)) {
        unique = `${label} ${suffix}`;
        suffix += 1;
      }
      used.add(unique);
      return unique;
    };

    const sumWindow = (rows) => {
      let total = 0;
      const models = {};
      for (const row of rows) {
        total += money(row && row.total_cost);
        const details = row && Array.isArray(row.model_details) ? row.model_details : [];
        for (const model of details) {
          const name = model && typeof model.model === "string" ? model.model : "";
          if (!name) continue;
          models[name] = (models[name] || 0) + money(model.total_cost);
        }
      }
      return { total, models };
    };
    const fromActivity = (payload) => {
      if (!payload || (payload.metadata && payload.metadata.has_more)) return null;
      const results = Array.isArray(payload.results) ? payload.results : [];
      const days = {};
      for (const day of results) {
        if (!day || typeof day.date !== "string" || day.date < start30 || day.date > end) continue;
        days[day.date] = (days[day.date] || 0) + money(day.metrics && day.metrics.spend);
      }
      const bucket = (from) => {
        let total = 0;
        const models = {};
        for (const day of results) {
          if (!day || typeof day.date !== "string" || day.date < from || day.date > end) continue;
          total += money(day.metrics && day.metrics.spend);
          const map = day.breakdown && day.breakdown.models;
          if (!map || typeof map !== "object") continue;
          for (const name of Object.keys(map)) {
            const info = map[name];
            const metrics = info && info.metrics ? info.metrics : info;
            models[name] = (models[name] || 0) + money(metrics && metrics.spend);
          }
        }
        return { total, models };
      };
      return { month: bucket(monthStart), days30: bucket(start30), days7: bucket(start7), days };
    };
    const reportWindow = async (key, from) => {
      const report = await load(key, `/key/spend/report?start_date=${from}&end_date=${end}`);
      if (report.error || !Array.isArray(report.json)) return { error: report.error || "invalid spend report" };
      return { window: sumWindow(report.json) };
    };

    const accounts = [];
    const usedLabels = new Set();
    for (let index = 0; index < keys.length; index += 1) {
      const entry = keys[index];
      const infoResult = await load(entry.key, "/key/info");
      if (infoResult.error || !infoResult.json || typeof infoResult.json.info !== "object") {
        accounts.push({
          label: labelFor(entry.label, null, index, usedLabels),
          month: null,
          detail: infoResult.error || "invalid key info",
        });
        continue;
      }
      const info = infoResult.json.info;
      const lifetime = money(info.spend);
      const keyHash = typeof infoResult.json.key === "string" ? infoResult.json.key : "";
      if (keyHash) {
        const activity = await load(
          entry.key,
          `/user/daily/activity?start_date=${start30}&end_date=${end}&api_key=${encodeURIComponent(keyHash)}`,
        );
        const windows = activity.error ? null : fromActivity(activity.json);
        if (windows) {
          accounts.push({
            label: labelFor(entry.label, info, index, usedLabels),
            month: windows.month.total,
            days30: windows.days30.total,
            days7: windows.days7.total,
            today: windows.days[end] || 0,
            lifetime,
            days: windows.days,
            models: windows.days30.models,
          });
          continue;
        }
      }
      const monthReport = await reportWindow(entry.key, monthStart);
      if (monthReport.window) {
        const days30 = await reportWindow(entry.key, start30);
        const days7 = await reportWindow(entry.key, start7);
        accounts.push({
          label: labelFor(entry.label, info, index, usedLabels),
          month: monthReport.window.total,
          days30: days30.window ? days30.window.total : null,
          days7: days7.window ? days7.window.total : null,
          lifetime,
          days: {},
          models: (days30.window && days30.window.models) || monthReport.window.models,
        });
        continue;
      }
      const denied = monthReport.error === "rejected" || monthReport.error === "denied";
      if (!denied) {
        accounts.push({
          label: labelFor(entry.label, info, index, usedLabels),
          month: null,
          lifetime,
          detail: monthReport.error || "invalid spend report",
        });
        continue;
      }
      const activity = await load(
        entry.key,
        `/user/daily/activity?start_date=${start30}&end_date=${end}`,
      );
      const windows = activity.error ? null : fromActivity(activity.json);
      if (!windows) {
        accounts.push({
          label: labelFor(entry.label, info, index, usedLabels),
          month: null,
          lifetime,
          detail: "no period report",
        });
        continue;
      }
      accounts.push({
        label: labelFor(entry.label, info, index, usedLabels),
        month: windows.month.total,
        days30: windows.days30.total,
        days7: windows.days7.total,
        today: windows.days[end] || 0,
        lifetime,
        days: windows.days,
        models: windows.days30.models,
      });
    }

    const dates = [];
    for (let time = Date.parse(`${start30}T00:00:00Z`); dates.length < 32; time += 86400000) {
      const day = new Date(time).toISOString().slice(0, 10);
      dates.push(day);
      if (day === end) break;
    }
    const euroAmount = (usd) => (fx ? usd * fx.rate : usd);
    const moneyText = (usd) => {
      if (typeof usd !== "number") return "n/a";
      const amount = euroAmount(usd);
      if (!fx) return ctx.format.usd(usd);
      if (usd > 0 && amount < 0.01) return "< €0.01";
      return ctx.format.currency(amount, "EUR");
    };
    const moneyRow = (label, value) => ({ label, value: moneyText(value) });
    const modelRowsFor = (models) => {
      const used = new Set();
      return Object.keys(models || {})
        .map((name) => ({ name, spend: models[name] }))
        .filter((model) => model.spend > 0)
        .sort((a, b) => b.spend - a.spend)
        .slice(0, 4)
        .map((model) => {
          const short = model.name.includes("/") ? model.name.slice(model.name.lastIndexOf("/") + 1) : model.name;
          const label = [short, model.name].find((value) => ctx.isDetailLabel(value) && !used.has(value));
          if (!label) return null;
          used.add(label);
          return { label, value: moneyText(model.spend) };
        })
        .filter(Boolean);
    };
    const rateHeader = {
      title: fx
        ? `ECB ${ctx.format.number(fx.rate, { minimumFractionDigits: 4, maximumFractionDigits: 4 })} · ${ctx.format.monthDay(fx.date)}`
        : "ECB rate unavailable",
      rows: [],
    };

    return {
      dataConfidence: fx ? "estimated" : "exact",
      details: [rateHeader, ...accounts.map((account) => {
        if (typeof account.month !== "number") {
          return {
            title: account.label,
            rows: [{ label: "Status", value: account.detail || "n/a" }],
          };
        }
        const spent = account.days || {};
        return {
          title: account.label,
          rows: [
            moneyRow("Today", account.today),
            moneyRow("7 days", account.days7),
            moneyRow("Month", account.month),
            moneyRow("30 days", account.days30),
            ...modelRowsFor(account.models),
            moneyRow("Lifetime", account.lifetime),
          ],
          chart: {
            kind: "bars",
            title: "Daily spend",
            unit: fx ? "EUR" : "USD",
            points: dates.map((date) => ({
              label: date.slice(5),
              value: euroAmount(spent[date] || 0),
            })),
          },
        };
      })],
      identity: { loginMethod: "api" },
    };
  },
});
