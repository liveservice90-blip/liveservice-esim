import {
  createHmac,
  timingSafeEqual
} from "node:crypto";

import { getStore } from "@netlify/blobs";
import paymentcallback from "./paymentcallback.mjs";

const reply = (status, data) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });

const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export default async (request) => {
  const secret =
    process.env.MYFATOORAH_WEBHOOK_SECRET?.trim();

  const apiKey =
    process.env.MYFATOORAH_API_KEY?.trim();

  if (request.method === "GET") {
    return reply(200, {
      message: "رابط استقبال إشعارات الدفع متاح",
      configured: Boolean(secret && apiKey)
    });
  }

  if (request.method !== "POST") {
    return reply(405, {
      error: "POST only"
    });
  }

  if (!secret || !apiKey) {
    return reply(503, {
      error: "Webhook not configured"
    });
  }

  let event;

  try {
    const body = await request.text();

    if (body.length > 65536) {
      return reply(413, {
        error: "Payload too large"
      });
    }

    event = JSON.parse(body);
  } catch {
    return reply(400, {
      error: "Invalid JSON"
    });
  }

  if (
    event?.Event?.Code !== 1 ||
    event.Event.Name !== "PAYMENT_STATUS_CHANGED"
  ) {
    return reply(400, {
      error: "Unsupported event"
    });
  }

  const invoice = event.Data?.Invoice;
  const transaction = event.Data?.Transaction;

  if (!invoice || !transaction) {
    return reply(400, {
      error: "Missing data"
    });
  }

  // ترتيب الحقول مطابق لتوقيع إشعار الدفع V2.
  const fields = [
    ["Invoice.Id", invoice.Id],
    ["Invoice.Status", invoice.Status],
    ["Transaction.Status", transaction.Status],
    ["Transaction.PaymentId", transaction.PaymentId],
    ["Invoice.ExternalIdentifier", invoice.ExternalIdentifier]
  ];

  if (
    fields.some(
      ([, value]) =>
        value != null &&
        !["string", "number"].includes(typeof value)
    )
  ) {
    return reply(400, {
      error: "Invalid signature fields"
    });
  }

  const signature =
    request.headers.get("myfatoorah-signature") || "";

  const signedData = fields
    .map(([key, value]) => `${key}=${value ?? ""}`)
    .join(",");

  const expected = createHmac("sha256", secret)
    .update(signedData, "utf8")
    .digest();

  const received = Buffer.from(signature, "base64");

  if (
    !/^[A-Za-z0-9+/]{43}=$/.test(signature) ||
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  ) {
    return reply(401, {
      error: "Invalid signature"
    });
  }

  if (
    invoice.Status !== "PAID" ||
    transaction.Status !== "SUCCESS"
  ) {
    return reply(200, {
      received: true,
      processed: false
    });
  }

  const paymentId = String(
    transaction.PaymentId ?? ""
  );

  if (!paymentId || paymentId.length > 250) {
    return reply(400, {
      error: "Invalid payment ID"
    });
  }

  try {
    // استعلام مستقل للتحقق من السداد ورقم الطلب.
    const response = await fetch(
      "https://api-sa.myfatoorah.com/v2/GetPaymentStatus",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          Key: paymentId,
          KeyType: "PaymentId"
        }),
        signal: AbortSignal.timeout(15000)
      }
    );

    const result = await response.json();

    if (
      !response.ok ||
      result.IsSuccess !== true ||
      !result.Data
    ) {
      return reply(503, {
        error: "Verification unavailable"
      });
    }

    const verified = result.Data;

    if (
      String(verified.InvoiceId) !==
      String(invoice.Id)
    ) {
      return reply(409, {
        error: "Invoice mismatch"
      });
    }

    if (verified.InvoiceStatus !== "Paid") {
      return reply(503, {
        error: "Awaiting payment confirmation"
      });
    }

    const orderId = verified.CustomerReference;

    // تجاهل الفواتير التي لا تحمل صيغة مرجع طلب الموقع.
    if (
      typeof orderId !== "string" ||
      !uuid.test(orderId)
    ) {
      return reply(200, {
        received: true,
        processed: false
      });
    }

    const store = getStore({
      name: "liveservice-orders"
    });

    const order = await store.get(
      `order:${orderId}`,
      { type: "json" }
    );

    if (!order) {
      return reply(503, {
        error: "Order not available yet"
      });
    }

    const invoiceAmount = Number(
      verified.InvoiceValue
    );

    if (
      String(order.invoiceId) !==
        String(verified.InvoiceId) ||
      order.currency !== "SAR" ||
      typeof order.amount !== "number" ||
      !Number.isFinite(order.amount) ||
      order.amount <= 0 ||
      !Number.isFinite(invoiceAmount) ||
      Math.abs(invoiceAmount - order.amount) > 0.001
    ) {
      return reply(409, {
        error: "Order mismatch"
      });
    }

    await store.setJSON(
      `notification:${orderId}:${order.invoiceId}`,
      {
        orderId,
        invoiceId: order.invoiceId,
        paymentId,
        receivedAt: new Date().toISOString()
      },
      { onlyIfNew: true }
    );

    // نفس مسار الإصدار ونفس حجز منع التكرار.
    const callback = new URL(
      "https://liveservice-esim.netlify.app/.netlify/functions/paymentcallback"
    );

    callback.searchParams.set("order", orderId);
    callback.searchParams.set("paymentId", paymentId);

    const completed = await paymentcallback(
      new Request(callback)
    );

    await completed.body?.cancel();

    if (completed.status !== 200) {
      return reply(503, {
        error: "Fulfillment pending"
      });
    }

    const delivery = await store.get(
      `delivery:${orderId}:${order.invoiceId}`,
      { type: "json" }
    );

    if (!delivery) {
      return reply(503, {
        error: "Delivery pending"
      });
    }

    return reply(200, {
      received: true,
      processed: true
    });
  } catch {
    return reply(503, {
      error: "Processing unavailable"
    });
  }
};
