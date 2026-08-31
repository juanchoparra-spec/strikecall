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

    // 1c. Fecha del earning MAS RECIENTE (puede no estar aun en stock/earnings)
    let mostRecentDate = null;
    try {
      const recentFrom = new Date();
      recentFrom.setMonth(today.getMonth() - 2);
      const recentRes = await fetch(
        `${FINNHUB_BASE}/calendar/earnings?from=${recentFrom.toISOString().slice(0,10)}&to=${today.toISOString().slice(0,10)}&symbol=${symbol}&token=${FINNHUB_API_KEY}`
      );
      const recentData = await recentRes.json();
      const pastRecent = (recentData.earningsCalendar || [])
        .filter((e) => new Date(e.date) <= today)
        .sort((a, b) => new Date(b.date) - new Date(a.date));
      if (pastRecent.length > 0) mostRecentDate = pastRecent[0].date;
    } catch (e) {
      mostRecentDate = null;
    }

    // 1d. Proximo earning estimado (calendar/earnings a futuro)
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

    // 2. Historial de earnings pasados (endpoint dedicado por simbolo)
    const earnRes = await fetch(
      `${FINNHUB_BASE}/stock/earnings?symbol=${symbol}&token=${FINNHUB_API_KEY}`
    );
    const earnData = await earnRes.json();

    if (!Array.isArray(earnData) || earnData.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: "No hay earnings pasados registrados para este ticker" }) };
    }

    // Este endpoint ya viene ordenado del mas reciente al mas antiguo
    let earningsCalendar = earnData
      .filter((e) => e.period && new Date(e.period) < today)
      .slice(0, 4)
      .map((e) => ({ date: e.period }));

    if (earningsCalendar.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: "No hay earnings pasados registrados para este ticker" }) };
    }

    // Si el calendario detecto un earning mas reciente que no esta en la lista, lo agregamos al frente
    if (mostRecentDate && !earningsCalendar.some((e) => e.date === mostRecentDate)) {
      earningsCalendar.unshift({ date: mostRecentDate });
    }
    earningsCalendar = earningsCalendar
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 4);

    // 1e. Horario de cada earning (bmo = antes de apertura, amc = despues de cierre)
    let hourMap = {};
    try {
      const hourFrom = new Date();
      hourFrom.setFullYear(today.getFullYear() - 2);
      const hourRes = await fetch(
        `${FINNHUB_BASE}/calendar/earnings?from=${hourFrom.toISOString().slice(0,10)}&to=${today.toISOString().slice(0,10)}&symbol=${symbol}&token=${FINNHUB_API_KEY}`
      );
      const hourData = await hourRes.json();
      (hourData.earningsCalendar || []).forEach((e) => {
        hourMap[e.date] = e.hour || "amc";
      });
    } catch (e) {
      hourMap = {};
    }

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
        results.push({ date: earn.date, hour, ...gapInfo });
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
