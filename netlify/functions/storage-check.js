exports.handler = async (event) => {
  const reply = (statusCode, data) => ({
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(data)
  });

  if (event.httpMethod !== "GET") {
    return reply(405, { error: "GET only" });
  }

  let store;
  let key;

  try {
    const { connectLambda, getStore } = require("@netlify/blobs");
    const { randomUUID } = require("node:crypto");

    connectLambda(event);

    store = getStore({
      name: "liveservice-storage-checks",
      consistency: "strong"
    });

    key = randomUUID();

    await store.setJSON(key, { test: key });

    const saved = await store.get(key, { type: "json" });

    if (saved?.test !== key) {
      throw new Error("Storage check failed");
    }

    return reply(200, {
      message: "تم التحقق من حفظ البيانات وقراءتها بنجاح"
    });
  } catch {
    return reply(500, {
      error: "تعذر التحقق من التخزين"
    });
  } finally {
    if (store && key) {
      await store.delete(key).catch(() => {});
    }
  }
};
