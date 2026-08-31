// netlify/functions/earnings.js
// Ultimos 4 earnings + gap $ / % + strike sugerido para Call
// Fuente: Finnhub (calendar/earnings + quote + candle)

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const FINNHUB_BASE = "https://finnhub.io/api/v1";

exports.handler = async (event) => {
  const symbol = (event.path.split("/").pop() || "").toUpperCase().trim();

  if (!symbol) {
    return { statusCode: 400, body: JSON.stringify({ error: "Falta el ticker" }) };
  }

  try {
    // 1. Precio actual
    const quoteRes = await fetch(
      `${FINNHUB_BASE}/quote?symbol=${symbol}&token=${FINNHUB_API_KEY}`
    );
    const quoteData = await quoteRes.json();
    const currentPrice = quoteData.c;

    if (!currentPrice) {
      return { statusCode: 404, body: JSON.stringify({ error: "No se encontro precio para este ticker" }) };
    }

    // 1b. Logo de la empresa
    let logo = "";
    try {
      const profRes = await fetch(
        `${FINNHUB_BASE}/stock/profile2?symbol=${symbol}&token=${FINNHUB_API_KEY}`
      );
      const profData = await profRes.json();
      logo = profData.logo || "";
    } catch (e) {
      logo = "";
    }

    const today = new Date();
    const fromDate = new Date();
    fromDate.setFullYear(today.getFullYear() - 2);

    // 1c. Proximo earning estimado (calendar/earnings a futuro)
    let nextEarningsDate = null;
    try {
      const futureTo = new Date();
      futureTo.setMonth(today.getMonth() + 4);
      const nextRes = await fetch(
        `${FINNHUB_BASE}/calendar/earnings?from=${today.toISOString().slice(0,10)}&to=${futureTo.toISOString().slice(0,10)}&symbol=${symbol}&token=${FINNHUB_API_KEY}`
      );
      const nextData = await nextRes.json();
      const upcoming = (nextData.earningsCalendar || [])
        .filter((e) => new Date(e.date) >= today)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
      if (upcoming.length > 0) nextEarningsDate = upcoming[0].date;
    } catch (e) {
      nextEarningsDate = null;
    }

    // 2. Historial de earnings pasados: fecha REAL de reporte + horario (bmo/amc)
    // Fuente principal: Nasdaq (API publica, sin key, confirmado con su propia tabla "Date Reported")
    let earningsCalendar = [];
    try {
      const nasdaqRes = await fetch(
        `https://api.nasdaq.com/api/company/${symbol}/earnings-surprise`,
        { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }
      );
      const nasdaqData = await nasdaqRes.json();
      const rows = nasdaqData?.data?.earningsSurpriseTable?.rows || [];
      earningsCalendar = rows
        .map((r) => {
          const rawDate = r.dateReported || r["Date Reported"] || r.date;
          if (!rawDate) return null;
          const parsed = new Date(rawDate);
          if (isNaN(parsed.getTime()) || parsed > today) return null;
          return { date: parsed.toISOString().slice(0,10), hour: "amc", estimated: false };
        })
        .filter((r) => r !== null)
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 4);
    } catch (e) {
      earningsCalendar = [];
    }

    // Fuente de respaldo: si Nasdaq no respondio o cambio de formato, usamos Finnhub por ventanas
    if (earningsCalendar.length === 0) {
      const earnRes = await fetch(
        `${FINNHUB_BASE}/stock/earnings?symbol=${symbol}&token=${FINNHUB_API_KEY}`
      );
      const earnData = await earnRes.json();

      if (Array.isArray(earnData) && earnData.length > 0) {
        const periods = earnData
          .filter((e) => e.period && new Date(e.period) < today)
          .slice(0, 4);

        const windowResults = await Promise.all(
          periods.map(async (p) => {
            const winFrom = new Date(p.period);
            const winTo = new Date(p.period);
            winTo.setDate(winTo.getDate() + 100);
            if (winTo > today) winTo.setTime(today.getTime());

            try {
              const winRes = await fetch(
                `${FINNHUB_BASE}/calendar/earnings?from=${winFrom.toISOString().slice(0,10)}&to=${winTo.toISOString().slice(0,10)}&symbol=${symbol}&token=${FINNHUB_API_KEY}`
              );
              const winData = await winRes.json();
              const matches = (winData.earningsCalendar || []).filter((e) => new Date(e.date) <= today);
              if (matches.length > 0) {
                return { date: matches[0].date, hour: matches[0].hour || "amc", estimated: false };
              }
            } catch (e) {}

            const approx = new Date(p.period);
            approx.setDate(approx.getDate() + 35);
            if (approx > today) return null;
            const day = approx.getUTCDay();
            if (day === 0) approx.setDate(approx.getDate() + 1);
            if (day === 6) approx.setDate(approx.getDate() + 2);
            return { date: approx.toISOString().slice(0,10), hour: "amc", estimated: true };
          })
        );

        earningsCalendar = windowResults
          .filter((r) => r !== null)
          .sort((a, b) => new Date(b.date) - new Date(a.date))
          .slice(0, 4);
      }
    }

    if (earningsCalendar.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: "No hay earnings pasados registrados para este ticker" }) };
    }

    // 2b. Confirmar horario (bmo/amc) de cada fecha ya conocida, consultando Finnhub
    // en una ventana angosta alrededor de esa fecha exacta (Nasdaq no da esta info)
    const hourResults = await Promise.all(
      earningsCalendar.map(async (e) => {
        const winFrom = new Date(e.date);
        winFrom.setDate(winFrom.getDate() - 3);
        const winTo = new Date(e.date);
        winTo.setDate(winTo.getDate() + 3);
        try {
          const hRes = await fetch(
            `${FINNHUB_BASE}/calendar/earnings?from=${winFrom.toISOString().slice(0,10)}&to=${winTo.toISOString().slice(0,10)}&symbol=${symbol}&token=${FINNHUB_API_KEY}`
          );
          const hData = await hRes.json();
          const match = (hData.earningsCalendar || []).find((x) => x.date === e.date);
          return match?.hour || "amc";
        } catch (err) {
          return "amc";
        }
      })
    );
    earningsCalendar.forEach((e, i) => { e.hour = hourResults[i]; });

    const hourMap = {};
    const estimatedMap = {};
    earningsCalendar.forEach((e) => { hourMap[e.date] = e.hour; estimatedMap[e.date] = e.estimated; });

    // 3. Historial de precios diarios (Yahoo Finance, no requiere API key)
    const fromTs = Math.floor(fromDate.getTime() / 1000);
    const toTs = Math.floor(today.getTime() / 1000);
    const yahooRes = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${fromTs}&period2=${toTs}&interval=1d`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const yahooData = await yahooRes.json();

    const chartResult = yahooData?.chart?.result?.[0];
    if (!chartResult) {
      return { statusCode: 404, body: JSON.stringify({ error: "No hay historial de precios disponible para este ticker" }) };
    }

    const closes = chartResult.indicators.quote[0].close;
    const opens = chartResult.indicators.quote[0].open;
    const timestamps = chartResult.timestamp.map((t) => new Date(t * 1000));

    const results = [];
    for (const earn of earningsCalendar) {
      const earnDate = new Date(earn.date);
      const hour = hourMap[earn.date] || "amc";
      const gapInfo = calculateGap(timestamps, closes, opens, earnDate, hour);
      if (gapInfo) {
        results.push({ date: earn.date, hour, estimated: !!estimatedMap[earn.date], ...gapInfo });
      }
    }

    if (results.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: "No se pudo calcular el movimiento historico" }) };
    }

    const avgMoveDollar = round2(
      results.reduce((sum, r) => sum + Math.abs(r.gap_dollar), 0) / results.length
    );
    const avgMovePercent = round2(
      results.reduce((sum, r) => sum + Math.abs(r.gap_percent), 0) / results.length
    );
    const positiveCount = results.filter((r) => r.direction === "up").length;
    const suggestedStrike = round2(currentPrice + avgMoveDollar);
    const suggestedPutStrike = round2(currentPrice - avgMoveDollar);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol,
        logo,
        current_price: round2(currentPrice),
        next_earnings_date: nextEarningsDate,
        earnings_history: results,
        avg_move_dollar: avgMoveDollar,
        avg_move_percent: avgMovePercent,
        positive_count: positiveCount,
        total_count: results.length,
        suggested_call_strike: suggestedStrike,
        suggested_put_strike: suggestedPutStrike,
      }),
    };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};

function calculateGap(timestamps, closes, opens, earnDate, hour) {
  // Encuentra el indice del dia exacto del earning (si cotiza ese dia)
  let earnIdx = -1;
  for (let i = 0; i < timestamps.length; i++) {
    if (sameDay(timestamps[i], earnDate)) { earnIdx = i; break; }
  }

  let prevIdx, reactionIdx;

  if (hour === "bmo") {
    // Reporta ANTES de abrir el mercado: el gap es cierre del dia anterior -> apertura del mismo dia
    reactionIdx = earnIdx !== -1 ? earnIdx : findFirstOnOrAfter(timestamps, earnDate);
    prevIdx = reactionIdx - 1;
  } else {
    // Reporta DESPUES del cierre (amc) o desconocido: cierre del dia del reporte -> apertura del dia siguiente
    prevIdx = earnIdx !== -1 ? earnIdx : findLastBefore(timestamps, earnDate);
    reactionIdx = prevIdx + 1;
  }

  if (prevIdx == null || reactionIdx == null || prevIdx < 0 || reactionIdx >= timestamps.length) return null;
  if (closes[prevIdx] == null || opens[reactionIdx] == null) return null;

  const prevClose = closes[prevIdx];
  const reactionOpen = opens[reactionIdx];
  const gapDollar = round2(reactionOpen - prevClose);
  const gapPercent = round2((gapDollar / prevClose) * 100);

  return {
    prev_close: round2(prevClose),
    reaction_close: round2(reactionOpen),
    gap_dollar: gapDollar,
    gap_percent: gapPercent,
    direction: gapDollar >= 0 ? "up" : "down",
  };
}

function sameDay(a, b) {
  return a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate();
}

function findLastBefore(timestamps, date) {
  let idx = -1;
  for (let i = 0; i < timestamps.length; i++) {
    if (timestamps[i] < date) idx = i;
  }
  return idx;
}

function findFirstOnOrAfter(timestamps, date) {
  for (let i = 0; i < timestamps.length; i++) {
    if (timestamps[i] >= date) return i;
  }
  return -1;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
