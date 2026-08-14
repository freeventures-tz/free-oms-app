import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import {
  SECRET_KEY,
  callApiRpc,
  createLiveStaff,
  ensureDirector,
  type Fixture,
} from "@/tests/integration/helpers";

/**
 * The catalogue and its prices, over real HTTP through PostgREST.
 *
 * pgTAP proves the rules inside the database. These tests prove the same rules survive the journey
 * a browser actually takes: a session token, a schema header, a JSON body — the layer where a
 * missing grant, an unexposed function or a wrong role shows up and a direct SQL session would
 * never notice.
 */

let director: Fixture;
let manager: Fixture;
let salesRep: Fixture;

beforeAll(async () => {
  director = await ensureDirector();
  manager = await createLiveStaff(director, "manager");
  salesRep = await createLiveStaff(director, "sales_rep");
});

/** A product nobody else in this run is touching. */
async function freshProduct(name: string): Promise<string> {
  const { data } = await director.api.rpc("admin_add_product", {
    p_name: name,
    p_specification: null,
    p_unit_code: "piece",
    p_idempotency_key: randomUUID(),
  });
  expect(data?.ok, JSON.stringify(data)).toBe(true);
  return (data.product as { id: string }).id;
}

describe("reading the catalogue", () => {
  it("is readable by every live role — a price is not a secret from the person selling", async () => {
    for (const [role, fixture] of [
      ["director", director],
      ["manager", manager],
      ["sales_rep", salesRep],
    ] as const) {
      const { data, error } = await fixture.read.from("products").select("id, name, unit_code");
      expect(error, `${role} could not read products: ${error?.message}`).toBeNull();
      expect((data ?? []).length, `${role} saw an empty catalogue`).toBeGreaterThanOrEqual(21);
    }
  });

  it("exposes the approved units and locations as reference data", async () => {
    const units = await salesRep.read.from("units").select("code");
    const locations = await salesRep.read.from("inventory_locations").select("code");

    expect(units.data?.length).toBe(6);
    expect((locations.data ?? []).map((row) => row.code).sort()).toEqual([
      "store",
      "warehouse",
      "yard",
    ]);
  });
});

describe("writing the catalogue", () => {
  it("lets a Director add a product, and gives it no price", async () => {
    const name = `Integration Product ${randomUUID().slice(0, 8)}`;
    const productId = await freshProduct(name);

    const { data: prices } = await director.read
      .from("product_prices")
      .select("id")
      .eq("product_id", productId);

    // The one that matters: a new product is priceless until a Director decides otherwise.
    expect(prices).toEqual([]);
  });

  it("refuses a Manager and a Sales Representative, at the database", async () => {
    const productId = await freshProduct(`Refusal Product ${randomUUID().slice(0, 8)}`);

    for (const [role, fixture] of [
      ["manager", manager],
      ["sales_rep", salesRep],
    ] as const) {
      const add = await fixture.api.rpc("admin_add_product", {
        p_name: `Sneaky ${role}`,
        p_specification: null,
        p_unit_code: "piece",
        p_idempotency_key: randomUUID(),
      });
      expect(add.error, `${role} was allowed to add a product`).not.toBeNull();

      const price = await fixture.api.rpc("admin_set_product_price", {
        p_product_id: productId,
        p_price_tzs: 9999,
        p_reason: "not my decision to make",
        p_idempotency_key: randomUUID(),
      });
      expect(price.error, `${role} was allowed to set a price`).not.toBeNull();
    }

    const { data: prices } = await director.read
      .from("product_prices")
      .select("id")
      .eq("product_id", productId);
    expect(prices, "a refused attempt left a price behind").toEqual([]);
  });

  it("gives the secret key no way to price anything", async () => {
    const productId = await freshProduct(`Secret Key Product ${randomUUID().slice(0, 8)}`);

    // `admin_*` is granted to `authenticated` only. The secret key can reach `service_*` and
    // nothing else, and there is no `service_` function here at all — this slice spans no second
    // system, so it needs no continuation.
    const response = await callApiRpc(
      "admin_set_product_price",
      {
        p_product_id: productId,
        p_price_tzs: 12345,
        p_reason: "issued by a leaked key",
        p_idempotency_key: randomUUID(),
      },
      SECRET_KEY,
    );

    expect(response.status).toBeGreaterThanOrEqual(400);

    const { data: prices } = await director.read
      .from("product_prices")
      .select("id")
      .eq("product_id", productId);
    expect(prices).toEqual([]);
  });

  it("refuses a direct write to the tables, whatever the role", async () => {
    // Hiding a control is a usability measure. This is the boundary: there is no INSERT grant for
    // `authenticated` on any catalogue table, so a hand-rolled request fails on privilege.
    const insertProduct = await director.read
      .from("products")
      .insert({ name: "Hand rolled", unit_code: "piece" });
    expect(insertProduct.error).not.toBeNull();

    const insertPrice = await director.read.from("product_prices").insert({
      product_id: randomUUID(),
      price_tzs: 1,
      reason: "hand rolled",
      set_by: director.userId,
      set_by_role: "director",
      correlation_id: randomUUID(),
    });
    expect(insertPrice.error).not.toBeNull();
  });
});

describe("selling prices", () => {
  it("records the change, the previous price, the Director and the reason", async () => {
    const productId = await freshProduct(`Priced Product ${randomUUID().slice(0, 8)}`);

    const first = await director.api.rpc("admin_set_product_price", {
      p_product_id: productId,
      p_price_tzs: 4500,
      p_reason: "Opening price",
      p_idempotency_key: randomUUID(),
    });
    expect(first.data?.reason).toBe("set");

    const second = await director.api.rpc("admin_set_product_price", {
      p_product_id: productId,
      p_price_tzs: 5200,
      p_reason: "Supplier raised prices",
      p_idempotency_key: randomUUID(),
    });
    expect(second.data?.reason).toBe("changed");

    const { data: history } = await director.read
      .from("product_prices")
      .select("price_tzs, previous_price_tzs, reason, set_by, set_by_role")
      .eq("product_id", productId)
      .order("entry_seq", { ascending: false });

    expect(history?.length).toBe(2);
    expect(history?.[0]).toMatchObject({
      price_tzs: 5200,
      previous_price_tzs: 4500,
      reason: "Supplier raised prices",
      set_by: director.userId,
      set_by_role: "director",
    });
    // The first entry replaced nothing, which is a different fact from replacing a zero.
    expect(history?.[1].previous_price_tzs).toBeNull();
  });

  it("shows the newest entry as the current price, to every role", async () => {
    const productId = await freshProduct(`Current Price ${randomUUID().slice(0, 8)}`);

    for (const price of [1000, 2000, 3000]) {
      await director.api.rpc("admin_set_product_price", {
        p_product_id: productId,
        p_price_tzs: price,
        p_reason: `moved to ${price}`,
        p_idempotency_key: randomUUID(),
      });
    }

    for (const fixture of [director, manager, salesRep]) {
      const { data } = await fixture.read
        .from("product_current_prices")
        .select("price_tzs")
        .eq("product_id", productId)
        .maybeSingle();
      expect(data?.price_tzs).toBe(3000);
    }
  });

  it("performs one operation however many times the same request arrives", async () => {
    const productId = await freshProduct(`Idempotent Price ${randomUUID().slice(0, 8)}`);
    const key = randomUUID();

    // Six identical requests at once — the impatient double-tap, arriving over the wire.
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        director.api.rpc("admin_set_product_price", {
          p_product_id: productId,
          p_price_tzs: 7700,
          p_reason: "same request, six times",
          p_idempotency_key: key,
        }),
      ),
    );

    for (const result of results) expect(result.data?.ok).toBe(true);

    const { data: history } = await director.read
      .from("product_prices")
      .select("id")
      .eq("product_id", productId);

    expect(history?.length, "a repeated request wrote more than one price").toBe(1);
  });

  it("refuses to record a change that changes nothing", async () => {
    const productId = await freshProduct(`Unchanged Price ${randomUUID().slice(0, 8)}`);

    await director.api.rpc("admin_set_product_price", {
      p_product_id: productId,
      p_price_tzs: 6000,
      p_reason: "Opening price",
      p_idempotency_key: randomUUID(),
    });

    const again = await director.api.rpc("admin_set_product_price", {
      p_product_id: productId,
      p_price_tzs: 6000,
      p_reason: "same figure",
      p_idempotency_key: randomUUID(),
    });

    expect(again.data?.ok).toBe(false);
    expect(again.data?.reason).toBe("price_unchanged");
  });

  it("cannot be rewritten or deleted through the API", async () => {
    const productId = await freshProduct(`Immutable Price ${randomUUID().slice(0, 8)}`);
    await director.api.rpc("admin_set_product_price", {
      p_product_id: productId,
      p_price_tzs: 8800,
      p_reason: "Opening price",
      p_idempotency_key: randomUUID(),
    });

    const update = await director.read
      .from("product_prices")
      .update({ price_tzs: 1 })
      .eq("product_id", productId);
    expect(update.error).not.toBeNull();

    const remove = await director.read
      .from("product_prices")
      .delete()
      .eq("product_id", productId);
    expect(remove.error).not.toBeNull();

    const { data: history } = await director.read
      .from("product_prices")
      .select("price_tzs")
      .eq("product_id", productId);
    expect(history?.[0].price_tzs).toBe(8800);
  });
});

describe("audit history", () => {
  it("attributes every catalogue write to the Director who made it", async () => {
    const name = `Audited Product ${randomUUID().slice(0, 8)}`;
    const productId = await freshProduct(name);

    await director.api.rpc("admin_set_product_price", {
      p_product_id: productId,
      p_price_tzs: 3300,
      p_reason: "Opening price",
      p_idempotency_key: randomUUID(),
    });

    const { data: events } = await director.read
      .from("audit_events")
      .select("action, actor_id, actor_role, is_system_actor")
      .eq("entity_id", productId);

    const actions = (events ?? []).map((row) => row.action).sort();
    expect(actions).toEqual(["product_added", "product_price_set"]);

    for (const event of events ?? []) {
      expect(event.actor_id).toBe(director.userId);
      expect(event.actor_role).toBe("director");
      expect(event.is_system_actor).toBe(false);
    }
  });
});
