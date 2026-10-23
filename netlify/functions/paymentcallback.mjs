import { getStore } from "@netlify/blobs";

export default async (request) => {
  const page = (status, message) =>
    new Response(
      `<!doctype html>
      <html lang="ar" dir="rtl">
      <head>
        <meta charset="utf-8">
        <meta name="viewport"
          content="width=device-width, initial-scale=1">
        <title>نتيجة الدفع | LiveService</title>
        <style>
          body {
            font-family: Tahoma, Arial;
            background: #f5f8f8;
            color: #183b41;
            margin: 0;
            padding: 30px 16px;
          }
          main {
            max-width: 600px;
            margin: 40px auto;
            background: white;
            padding: 28px;
            border-radius: 18px;
            line-height: 2;
          }
          a { color: #087f85; }
        </style>
      </head>
      <body>
        <main>
          <h1>LiveService</h1>
          <p>${message}</p>
          <a href="/">العودة إلى الموقع</a>
        </main>
      </body>
      </html>`,
      {
        status,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy":
            "default-src 'none'; style-src 'unsafe-inline'; " +
            "base-uri 'none'; frame-ancestors 'none'"
        }
      }
    );

  if (request.method !== "GET") {
    return page(405, "طريقة الطلب غير مسموحة.");
  }

  const url = new URL(request.url);
  const orderId = url.searchParams.get("order");
  const paymentId = url.searchParams.get("paymentId");

  if (
    !orderId ||
    !/^[a-f0-9-]{36}$/i.test(orderId) ||
    !paymentId ||
    paymentId.length > 250
  ) {
    return page(400, "بيانات التحقق من الدفع غير مكتملة.");
  }

  const key = process.env.MYFATOORAH_API_KEY?.trim();

  if (!key) {
    return page(503, "خدمة التحقق غير متاحة حاليًا.");
  }

  try {
    const store = getStore({
      name: "liveservice-orders"
    });

    const order = await store.get(`order:${orderId}`, {
      type: "json"
    });

    if (!order) {
      return page(404, "لم يتم العثور على الطلب.");
    }

    if (
      order.currency !== "SAR" ||
      typeof order.amount !== "number" ||
      !Number.isFinite(order.amount) ||
      order.amount <= 0 ||
      !order.invoiceId
    ) {
      return page(409, "تعذر مطابقة بيانات الطلب.");
    }

    const response = await fetch(
      "https://api-sa.myfatoorah.com/v2/GetPaymentStatus",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
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
      return page(
        502,
        "تعذر التحقق من الدفع حاليًا. احتفظ بإيصال العملية."
      );
    }

    const invoice = result.Data;
    const invoiceAmount = Number(invoice.InvoiceValue);

    if (
      String(invoice.InvoiceId) !== String(order.invoiceId) ||
      invoice.CustomerReference !== orderId ||
      !Number.isFinite(invoiceAmount) ||
      Math.abs(invoiceAmount - order.amount) > 0.001
    ) {
      return page(
        409,
        "تعذر مطابقة الفاتورة مع الطلب. تواصل مع الدعم."
      );
    }

    if (invoice.InvoiceStatus !== "Paid") {
      return page(
        200,
        "لم يتم تأكيد سداد الفاتورة. قد تكون العملية معلّقة أو غير مكتملة."
      );
    }

    await store.setJSON(
      `verified:${orderId}:${order.invoiceId}`,
      {
        orderId,
        invoiceId: order.invoiceId,
        amount: order.amount,
        currency: order.currency,
        paymentVerified: true,
        verifiedAt: new Date().toISOString()
      }
    );

    return page(
      200,
      "تم التحقق من سداد الفاتورة. تأكيد الدفع وحده لا يعني إصدار الشريحة؛ يرجى متابعة حالة طلبك مع الدعم."
    );
  } catch {
    return page(
      502,
      "تعذر إكمال التحقق حاليًا. احتفظ بإيصال الدفع وتواصل مع الدعم قبل إعادة الدفع."
    );
  }
};
