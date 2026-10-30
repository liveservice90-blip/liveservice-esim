import { parseGift } from "./gift.mjs";
import { getStore } from "@netlify/blobs";
import { randomUUID } from "node:crypto";
import catalogue from "./catalogue.js";

const SITE_URL = "https://liveservice-esim.netlify.app";
const PAYMENT_API = "https://api-sa.myfatoorah.com";

export default async (request) => {
  const reply = (status, data) =>
    new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });

  if (request.method !== "POST") {
    return reply(405, {
      error: "استخدم POST لإنشاء الطلب"
    });
  }

  if (process.env.PAYMENTS_ENABLED !== "true") {
    return reply(503, {
      error: "الدفع غير مفعّل بعد"
    });
  }

  const key = process.env.MYFATOORAH_API_KEY?.trim();

  if (!key) {
    return reply(503, {
      error: "خدمة الدفع غير متاحة حاليًا"
    });
  }

  let input;

  try {
    const body = await request.text();

    if (body.length > 5000) {
      return reply(413, {
        error: "حجم الطلب أكبر من المسموح"
      });
    }

    input = JSON.parse(body);
  } catch {
    return reply(400, {
      error: "بيانات الطلب غير صحيحة"
    });
  }

  if (
    !input ||
    typeof input.bundleName !== "string" ||
    !input.bundleName.trim() ||
    input.bundleName.length > 250
  ) {
    return reply(400, {
      error: "اختر الباقة أولًا"
    });
  }

  const customerName =
    typeof input.customerName === "string"
      ? input.customerName.trim()
      : "";

  const customerEmail =
    typeof input.customerEmail === "string"
      ? input.customerEmail.trim()
      : "";

  if (
    customerName.length < 2 ||
    customerName.length > 100 ||
    /[\u0000-\u001f\u007f]/.test(customerName)
  ) {
    return reply(400, {
      error: "أدخل اسم العميل بشكل صحيح"
    });
  }

  if (
    customerEmail.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)
  ) {
    return reply(400, {
      error: "أدخل بريدًا إلكترونيًا صحيحًا"
    });
  }

  let gift;

  try {
    gift = parseGift(input.gift);
  } catch (error) {
    return reply(400, {
      error: error.message
    });
  }

  try {
    // السعر يؤخذ من الخادم ولا يؤخذ من المتصفح.
    const catalogueResponse = await catalogue.handler({
      httpMethod: "GET"
    });

    if (catalogueResponse.statusCode !== 200) {
      return reply(502, {
        error: "تعذر التحقق من سعر الباقة"
      });
    }

    const catalogueData = JSON.parse(
      catalogueResponse.body
    );

    const bundle = catalogueData.bundles?.find(
      item => item.name === input.bundleName
    );

    if (!bundle) {
      return reply(404, {
        error: "الباقة غير متاحة حاليًا"
      });
    }

    if (
      bundle.currency !== "SAR" ||
      typeof bundle.salePrice !== "number" ||
      !Number.isFinite(bundle.salePrice) ||
      bundle.salePrice <= 0
    ) {
      return reply(502, {
        error: "تعذر التحقق من السعر أو العملة"
      });
    }

    const amount = Number(bundle.salePrice.toFixed(2));
    const orderId = randomUUID();

    const store = getStore({
      name: "liveservice-orders"
    });

    const order = {
      orderId,
      bundleName: bundle.name,
      description: bundle.description || bundle.name,
      amount,
      currency: "SAR",
      customerName,
      customerEmail,
      gift,
      createdAt: new Date().toISOString()
    };

    // حفظ مسودة لاستعادة المرجع عند انقطاع الاتصال.
    await store.setJSON(`draft:${orderId}`, order);

    const callback = new URL(
      "/.netlify/functions/paymentcallback",
      SITE_URL
    );

    callback.searchParams.set("order", orderId);

    const paymentResponse = await fetch(
      `${PAYMENT_API}/v2/SendPayment`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          CustomerName: customerName,
          CustomerEmail: customerEmail,
          NotificationOption: "LNK",
          InvoiceValue: amount,
          DisplayCurrencyIso: "SAR",
          CallBackUrl: callback.toString(),
          ErrorUrl: callback.toString(),
          Language: "AR",
          CustomerReference: orderId,
          InvoiceItems: [
            {
              ItemName: order.description,
              Quantity: 1,
              UnitPrice: amount
            }
          ]
        }),
        signal: AbortSignal.timeout(15000)
      }
    );

    const payment = await paymentResponse.json();
    const invoice = payment.Data;

    if (
      !paymentResponse.ok ||
      payment.IsSuccess !== true ||
      !Number.isSafeInteger(invoice?.InvoiceId) ||
      invoice.InvoiceId <= 0 ||
      typeof invoice.InvoiceURL !== "string"
    ) {
      return reply(502, {
        error: "تعذر إنشاء فاتورة الدفع"
      });
    }

    const paymentUrl = new URL(invoice.InvoiceURL);

    const trustedHost =
      paymentUrl.hostname === "myfatoorah.com" ||
      paymentUrl.hostname.endsWith(".myfatoorah.com");

    if (
      paymentUrl.protocol !== "https:" ||
      !trustedHost ||
      paymentUrl.username ||
      paymentUrl.password
    ) {
      throw new Error("Unexpected payment URL");
    }

    // حفظ الطلب النهائي قبل إرسال رابط الدفع للمتصفح.
    await store.setJSON(`order:${orderId}`, {
      ...order,
      invoiceId: invoice.InvoiceId
    });

    return reply(200, {
      orderId,
      amount,
      currency: "SAR",
      paymentUrl: paymentUrl.toString()
    });
  } catch {
    return reply(502, {
      error: "تعذر تجهيز رابط الدفع، حاول لاحقًا"
    });
  }
};
