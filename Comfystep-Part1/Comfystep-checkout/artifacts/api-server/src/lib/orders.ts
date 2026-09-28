import { asc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, ordersTable, type Order, type StoredOrderPair } from "@workspace/db";
import { logger } from "./logger";
import {
  CreateOrderBody,
  GetOrderParams,
  GetOrderResponse,
  type OrderInput,
} from "@workspace/api-zod";

export const DELIVERY_TAGLINE = "توصيل لجميع محافظات المملكة 🇯🇴";
export const DELIVERY_DAYS = "1-3";
export const DELIVERY_NOTE = "";

const DELIVERY_ESTIMATE_DAYS = 3;
const DISCOUNT_CODES: Record<string, number> = {};

const TIER_PRICING = {
  1: { offer: 14.99, original: 30 },
  2: { offer: 19.99, original: 40 },
  3: { offer: 24.99, original: 50 },
} as const;

const arabicMonths = [
  "كانون الثاني",
  "شباط",
  "آذار",
  "نيسان",
  "أيار",
  "حزيران",
  "تموز",
  "آب",
  "أيلول",
  "تشرين الأول",
  "تشرين الثاني",
  "كانون الأول",
];

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function getDeliveryDate() {
  const date = new Date();
  date.setDate(date.getDate() + DELIVERY_ESTIMATE_DAYS);
  return `${date.getDate()} ${arabicMonths[date.getMonth()]}`;
}

export function calculateOrderTotals(input: Pick<OrderInput, "pairs" | "discountCode">) {
  const tier = TIER_PRICING[input.pairs.length as 1 | 2 | 3];
  if (!tier) {
    throw new Error("Invalid pair count");
  }

  const normalizedCode = input.discountCode?.trim().toUpperCase();
  if (normalizedCode && !(normalizedCode in DISCOUNT_CODES)) {
    throw new Error("رمز الخصم غير صالح");
  }

  const codeDiscount = normalizedCode ? DISCOUNT_CODES[normalizedCode] : 0;
  const total = roundMoney(Math.max(0, tier.offer - codeDiscount));

  return {
    original: tier.original,
    offer: tier.offer,
    discount: roundMoney(tier.original - total),
    codeDiscount,
    shipping: "",
    total,
  };
}

function itemsText(pairs: StoredOrderPair[]) {
  return pairs.map((pair, index) => `زوج ${index + 1}: ${pair.color} ${pair.size}`).join(" | ");
}

export function toOrderResponse(order: Order) {
  return GetOrderResponse.parse({
    ...order,
    pairs: order.pairs,
    deliveryTagline: DELIVERY_TAGLINE,
    deliveryDays: DELIVERY_DAYS,
    deliveryDate: getDeliveryDate(),
  });
}

export async function createStoredOrder(input: OrderInput) {
  const totals = calculateOrderTotals(input);
  const pairs = input.pairs as StoredOrderPair[];

  const order = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(847291);`);
    const [latest] = await tx
      .select({ maxOrderNumber: sql<number | null>`max(${ordersTable.orderNumber})` })
      .from(ordersTable);
    const nextOrderNumber = Math.max(1001, Number(latest?.maxOrderNumber ?? 1000) + 1);

    const [created] = await tx
      .insert(ordersTable)
      .values({
        orderNumber: nextOrderNumber,
        orderToken: randomUUID(),
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        phone: input.phone.trim(),
        address: input.address.trim(),
        city: input.city,
        pairs,
        itemsText: itemsText(pairs),
        subtotal: totals.original,
        discount: totals.discount,
        shipping: totals.shipping,
        total: totals.total,
        paymentMethod: input.paymentMethod,
      })
      .returning();

    return created;
  });

  if (!order) {
    throw new Error("Order could not be created");
  }

  return order;
}

function webhookPayload(order: Order) {
  return {
    token: process.env.SHEETS_WEBHOOK_TOKEN,
    orderNumber: order.orderNumber,
    createdAt: order.createdAt.toISOString(),
    firstName: order.firstName,
    lastName: order.lastName,
    phone: order.phone,
    city: order.city,
    address: order.address,
    itemsText: order.itemsText,
    pairs: order.pairs.length,
    subtotal: order.subtotal,
    discount: order.discount,
    shipping: "",
    total: order.total,
    paymentMethod: order.paymentMethod,
  };
}

function safeResponsePreview(body: string, token: string) {
  const redacted = body
    .replaceAll(token, "[redacted]")
    .replace(/\b(?:token|authorization|access_token|id_token)\b\s*[:=]\s*["']?[^"',}\s]+["']?/gi, "$1=[redacted]");
  const title = redacted.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
  const text = redacted
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
  return [title ? `title=${title}` : "", text ? `text=${text}` : ""].filter(Boolean).join(" | ");
}

async function postToSheetWebhook(webhookUrl: string, payload: ReturnType<typeof webhookPayload>) {
  let currentUrl = webhookUrl;
  let redirectCount = 0;
  const maxRedirects = 6;
  const body = JSON.stringify(payload);
  let method: "POST" | "GET" = "POST";

  while (true) {
    const response = await fetch(currentUrl, {
      method,
      headers: method === "POST" ? { "content-type": "application/json" } : undefined,
      body: method === "POST" ? body : undefined,
      redirect: "manual",
    });
    const location = response.headers.get("location");

    if (location && response.status >= 300 && response.status < 400) {
      if (redirectCount >= maxRedirects) {
        throw new Error(`Sheet webhook exceeded ${maxRedirects} redirects`);
      }
      redirectCount += 1;
      currentUrl = new URL(location, currentUrl).toString();
      // Google Apps Script uses a 302 wrapper redirect to its content endpoint.
      // The initial request carries the JSON payload; only 307/308 require the
      // redirected request to preserve the original POST method and body.
      method = response.status === 307 || response.status === 308 ? "POST" : "GET";
      continue;
    }

    const responseBody = await response.text();
    return {
      status: response.status,
      statusText: response.statusText,
      body: responseBody,
      redirectCount,
      finalPath: new URL(currentUrl).pathname,
      contentType: response.headers.get("content-type") ?? undefined,
    };
  }
}

export async function syncOrder(order: Order) {
  const webhookUrl = process.env.SHEETS_WEBHOOK_URL;
  const webhookToken = process.env.SHEETS_WEBHOOK_TOKEN;
  if (!webhookUrl || !webhookToken) {
    logger.warn(
      { orderNumber: order.orderNumber, hasWebhookUrl: Boolean(webhookUrl), hasWebhookToken: Boolean(webhookToken) },
      "Sheet sync skipped because webhook configuration is incomplete",
    );
    return false;
  }

  try {
    const response = await postToSheetWebhook(webhookUrl, webhookPayload(order));
    logger.info(
      {
        orderNumber: order.orderNumber,
        status: response.status,
        statusText: response.statusText,
        redirectCount: response.redirectCount,
        finalPath: response.finalPath,
        contentType: response.contentType,
        responseBodyPreview: safeResponsePreview(response.body, webhookToken),
      },
      "Sheet webhook response",
    );

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Sheet webhook returned ${response.status}`);
    }

    await db
      .update(ordersTable)
      .set({ synced: true, lastSyncAttemptAt: new Date(), syncAttempts: order.syncAttempts + 1 })
      .where(eq(ordersTable.id, order.id));
    return true;
  } catch (error) {
    logger.error(
      {
        orderNumber: order.orderNumber,
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      "Sheet webhook request failed",
    );
    await db
      .update(ordersTable)
      .set({ lastSyncAttemptAt: new Date(), syncAttempts: order.syncAttempts + 1 })
      .where(eq(ordersTable.id, order.id));
    return false;
  }
}

export async function retryUnsyncedOrders() {
  if (!process.env.SHEETS_WEBHOOK_URL || !process.env.SHEETS_WEBHOOK_TOKEN) {
    logger.warn("Unsynced order retry skipped because webhook configuration is incomplete");
    return;
  }

  const unsynced = await db
    .select()
    .from(ordersTable)
    .where(eq(ordersTable.synced, false))
    .orderBy(asc(ordersTable.createdAt))
    .limit(25);

  if (unsynced.length > 0) {
    logger.info({ count: unsynced.length }, "Retrying unsynced orders");
  }
  for (const order of unsynced) {
    await syncOrder(order);
  }
}

export function parseOrderToken(value: unknown) {
  return GetOrderParams.safeParse({ orderToken: value });
}

export const orderResponseSchema = GetOrderResponse;