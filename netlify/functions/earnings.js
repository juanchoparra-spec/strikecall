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

    // 2. Fechas de earnings pasadas (ultimos ~2 anios para asegurar 4 reportados)
    const today = new Date();
    const fromDate = new Date();
    fromDate.setFullYear(today.getFullYear() - 2);

    const calRes = await fetch(
      `${FINNHUB_BASE}/calendar/earnings?from=${fromDate.toISOString().slice(0,10)}&to=${today.toISOString().slice(0,10)}&symbol=${symbol}&token=${FINNHUB_API_KEY}`
    );
    const calData = await calRes.json();
    let earningsCalendar = (calData.earningsCalendar || [])
      .filter((e) => new Date(e.date) < today)
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 4);

    if (earningsCalendar.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: "No hay earnings pasados registrados para este ticker" }) };
    }

    // 3. Historial de precios diarios (para calcular cierre previo / reaccion)
    const fromTs = Math.floor(fromDate.getTime() / 1000);
    const toTs = Math.floor(today.getTime() / 1000);
    const candleRes = await fetch(
      `${FINNHUB_BASE}/stock/candle?symbol=${symbol}&resolution=D&from=${fromTs}&to=${toTs}&token=${FINNHUB_API_KEY}`
    );
    const candleData = await candleRes.json();

    if (candleData.s !== "ok") {
      return { statusCode: 404, body: JSON.stringify({ error: "No hay historial de precios disponible (revisa tu plan de Finnhub)" }) };
    }

    const closes = candleData.c;
    const timestamps = candleData.t.map((t) => new Date(t * 1000));

    const results = [];
    for (const earn of earningsCalendar) {
      const earnDate = new Date(earn.date);
      const gapInfo = calculateGap(timestamps, closes, earnDate);
      if (gapInfo) {
        results.push({ date: earn.date, ...gapInfo });
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

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol,
        current_price: round2(currentPrice),
        earnings_history: results,
        avg_move_dollar: avgMoveDollar,
        avg_move_percent: avgMovePercent,
        positive_count: positiveCount,
        total_count: results.length,
        suggested_call_strike: suggestedStrike,
      }),
    };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};

function calculateGap(timestamps, closes, earnDate) {
  let prevIdx = -1;
  let afterIdx = -1;

  for (let i = 0; i < timestamps.length; i++) {
    if (timestamps[i] < earnDate) prevIdx = i;
    if (timestamps[i] >= earnDate && afterIdx === -1) afterIdx = i;
  }

  if (prevIdx === -1 || afterIdx === -1) return null;

  const prevClose = closes[prevIdx];
  const reactionClose = closes[afterIdx];
  const gapDollar = round2(reactionClose - prevClose);
  const gapPercent = round2((gapDollar / prevClose) * 100);

  return {
    prev_close: round2(prevClose),
    reaction_close: round2(reactionClose),
    gap_dollar: gapDollar,
    gap_percent: gapPercent,
    direction: gapDollar >= 0 ? "up" : "down",
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
