import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import {
  SECRET_KEY,
  callApiRpc,
  createLiveStaff,
  ensureDirector,
  summariseBurst,
  type Fixture,
} from "@/tests/integration/helpers";

/**
 * Counting units and product content, over real HTTP (Stage 10 Part C, product.md §6).
 *
 * The journey being proved is the one a Director actually takes: create the counting unit you need,
 * then use it immediately for the product you were part-way through adding. pgTAP proves the rules
 * inside the database. These prove they survive PostgREST, which is where a missing grant, an
 * unexposed function or a defaulted argument shows up and a direct SQL session never would.
 */

let director: Fixture;
let secondDirector: Fixture;
let manager: Fixture;
let salesRep: Fixture;

beforeAll(async () => {
  director = await ensureDirector();
  // Either Director may act independently (product.md §4), and a key one of them claimed must not
  // be replayable by the other.
  secondDirector = await createLiveStaff(director, "director");
  manager = await createLiveStaff(director, "manager");
  salesRep = await createLiveStaff(director, "sales_rep");
});

/** A counting unit nobody else in this run is touching, named in both languages. */
async function freshUnit(stem: string): Promise<{ code: string; labelEn: string }> {
  const labelEn = `${stem} ${randomUUID().slice(0, 8)}`;
  const { data } = await director.api.rpc("admin_add_unit", {
    p_label_en: labelEn,
    p_label_sw: `${labelEn} sw`,
    p_idempotency_key: randomUUID(),
  });
  expect(data?.ok, JSON.stringify(data)).toBe(true);
  return { code: (data.unit as { code: string }).code, labelEn };
}

describe("the counting units on offer", () => {
  it("are the generic ones, with the package-specific rows retired but readable", async () => {
    const { data, error } = await salesRep.read
      .from("units")
      .select("code, label_en, label_sw, is_active");

    expect(error).toBeNull();
    const byCode = new Map((data ?? []).map((row) => [row.code as string, row]));

    // Stated as an invariant rather than an exact set: a Director creating a unit is ordinary use
    // of this feature, and the tests below do exactly that against the same database.
    for (const code of ["piece", "bag", "bucket", "sheet", "bar"]) {
      expect(byCode.get(code)?.is_active, `${code} is not offered`).toBe(true);
    }

    // The three Part B rows that answered two questions at once. Kept so an old row can still be
    // read back, and unavailable to anything new.
    for (const code of ["piece_12ft", "bag_50kg", "bucket_20l"]) {
      expect(byCode.get(code)?.is_active, `${code} is still on offer`).toBe(false);
    }

    // Every unit carries both labels, because the screen reads them from here rather than from a
    // message file (design.md §8.2).
    for (const row of data ?? []) {
      expect(String(row.label_en).trim().length, `${row.code} has no English label`).toBeGreaterThan(
        0,
      );
      expect(String(row.label_sw).trim().length, `${row.code} has no Swahili label`).toBeGreaterThan(
        0,
      );
    }
  });
});

describe("creating a counting unit", () => {
  it("lets a Director create one and use it immediately", async () => {
    const { code, labelEn } = await freshUnit("drum");

    const { data: row } = await salesRep.read
      .from("units")
      .select("label_en, label_sw, is_active, created_by")
      .eq("code", code)
      .single();

    // Readable by everyone the moment it exists, in both languages.
    expect(row).toMatchObject({ label_en: labelEn, label_sw: `${labelEn} sw`, is_active: true });
    expect(row?.created_by).toBe(director.userId);

    // Used straight away, with nothing reloading in between. This is the sequence the Add product
    // form performs, and the reason the command returns the unit rather than just a success.
    const name = `Unit Consumer ${randomUUID().slice(0, 8)}`;
    const { data: product } = await director.api.rpc("admin_add_product", {
      p_name: name,
      p_specification: null,
      p_unit_code: code,
      p_unit_content: "200 litres",
      p_idempotency_key: randomUUID(),
    });

    expect(product?.reason, JSON.stringify(product)).toBe("added");
    expect(product.product).toMatchObject({ unit_code: code, unit_content: "200 litres" });
  });

  it("refuses a Manager and a Sales Representative, at the database", async () => {
    for (const [role, fixture] of [
      ["manager", manager],
      ["sales_rep", salesRep],
    ] as const) {
      const created = await fixture.api.rpc("admin_add_unit", {
        p_label_en: `sneaky ${role}`,
        p_label_sw: `sneaky ${role} sw`,
        p_idempotency_key: randomUUID(),
      });
      expect(created.error, `${role} was allowed to create a counting unit`).not.toBeNull();
    }

    const { data: rows } = await director.read
      .from("units")
      .select("code")
      .ilike("label_en", "sneaky%");
    expect(rows, "a refused attempt left a unit behind").toEqual([]);
  });

  it("refuses a direct write, and offers no rename or delete path to anybody", async () => {
    // Hiding a control is a usability measure. This is the boundary: there is no INSERT, UPDATE or
    // DELETE grant for `authenticated` on `units`, so a hand-rolled request fails on privilege
    // before a policy is ever consulted.
    const insert = await director.read.from("units").insert({
      code: "hand_rolled",
      sort_order: 99,
      label_en: "hand rolled",
      label_sw: "kwa mkono",
    });
    expect(insert.error).not.toBeNull();

    const rename = await director.read
      .from("units")
      .update({ label_en: "renamed" })
      .eq("code", "piece");
    expect(rename.error).not.toBeNull();

    const remove = await director.read.from("units").delete().eq("code", "piece");
    expect(remove.error).not.toBeNull();

    const { data: row } = await director.read
      .from("units")
      .select("label_en")
      .eq("code", "piece")
      .single();
    expect(row?.label_en).toBe("piece");
  });

  it("gives the secret key no way to create one", async () => {
    // `admin_*` is granted to `authenticated` only. The secret key reaches `service_*` and nothing
    // else, and this slice spans no second system, so it needs no continuation function.
    const response = await callApiRpc(
      "admin_add_unit",
      {
        p_label_en: `leaked ${randomUUID().slice(0, 8)}`,
        p_label_sw: "iliyovuja",
        p_idempotency_key: randomUUID(),
      },
      SECRET_KEY,
    );

    expect(response.status).toBeGreaterThanOrEqual(400);

    const { data: rows } = await director.read
      .from("units")
      .select("code")
      .ilike("label_en", "leaked%");
    expect(rows).toEqual([]);
  });

  it("refuses a blank label in either language", async () => {
    for (const [what, args] of [
      ["English", { p_label_en: "   ", p_label_sw: "ngoma" }],
      ["Swahili", { p_label_en: `drum ${randomUUID().slice(0, 8)}`, p_label_sw: "" }],
    ] as const) {
      const result = await director.api.rpc("admin_add_unit", {
        ...args,
        p_idempotency_key: randomUUID(),
      });
      expect(result.data?.reason, `a blank ${what} label was accepted`).toBe("label_required");
    }
  });

  it("refuses a unit that repeats an active one in different clothes", async () => {
    const { labelEn } = await freshUnit("barrel");

    for (const variant of [labelEn.toUpperCase(), `  ${labelEn}  `, labelEn.replace(" ", "  ")]) {
      const result = await director.api.rpc("admin_add_unit", {
        p_label_en: variant,
        p_label_sw: `something else ${randomUUID().slice(0, 8)}`,
        p_idempotency_key: randomUUID(),
      });
      expect(result.data?.reason, `"${variant}" was accepted as a new unit`).toBe("unit_exists");
    }
  });

  it("performs one operation however many times the same request arrives", async () => {
    const labelEn = `crate ${randomUUID().slice(0, 8)}`;
    const key = randomUUID();
    const request = { p_label_en: labelEn, p_label_sw: `${labelEn} sw`, p_idempotency_key: key };

    // Six identical requests at once: the impatient double-tap, arriving over the wire.
    const results = await Promise.all(
      Array.from({ length: 6 }, () => director.api.rpc("admin_add_unit", request)),
    );

    // Not "they all said ok". Exactly one of them DID the work and the other five were handed that
    // same work back. A caller told `unit_exists` because a sibling won the race is a refusal for a
    // request that succeeded, and a caller handed a different row is a success for a unit nobody
    // asked for; the counts below separate all three outcomes.
    const burst = summariseBurst(results, "unit");
    expect(burst, JSON.stringify(burst)).toMatchObject({ ok: 6, added: 1, replayed: 5 });
    expect(burst.ids, "the six callers were not handed one shared unit").toHaveLength(1);

    const { data: rows } = await director.read.from("units").select("code").eq("label_en", labelEn);
    expect(rows?.length, "a repeated request created more than one unit").toBe(1);

    // One operation means one entry in the permanent record, too. Six would read as six decisions.
    const { data: events } = await director.read
      .from("audit_events")
      .select("action")
      .eq("entity_id", burst.ids[0]);
    expect(events, "a repeated request wrote more than one audit event").toEqual([
      { action: "unit_added" },
    ]);

    // The same key for different labels is a conflict, and changes nothing.
    const reused = await director.api.rpc("admin_add_unit", {
      p_label_en: `${labelEn} other`,
      p_label_sw: "kitu kingine",
      p_idempotency_key: key,
    });
    expect(reused.data?.reason).toBe("idempotency_key_conflict");

    const { data: after } = await director.read
      .from("units")
      .select("code")
      .eq("label_en", `${labelEn} other`);
    expect(after).toEqual([]);

    // And the other Director cannot replay a key they never claimed.
    const other = await secondDirector.api.rpc("admin_add_unit", request);
    expect(other.data?.reason).toBe("idempotency_key_conflict");
  });

  it("replays the one committed unit in every one of twenty concurrent bursts", async () => {
    // One burst passing is a coin landing heads. The race this proves absent is a window of a few
    // milliseconds between classifying an unclaimed key and claiming it, so it needs enough
    // independent attempts that a surviving window shows up rather than hides.
    //
    // Twenty bursts, each with its own labels and its own key, so no burst can be rescued by
    // another burst's row. Sequential bursts of six rather than 120 requests at once: the point is
    // to collide on ONE key, and 120 open connections would only prove the pool has a limit.
    for (let batch = 0; batch < 20; batch++) {
      const labelEn = `pallet ${randomUUID().slice(0, 8)}`;
      const request = {
        p_label_en: labelEn,
        p_label_sw: `${labelEn} sw`,
        p_idempotency_key: randomUUID(),
      };

      const burst = summariseBurst(
        await Promise.all(
          Array.from({ length: 6 }, () => director.api.rpc("admin_add_unit", request)),
        ),
        "unit",
      );

      // Reported with the batch number and the reasons, because "expected 1, got 0" on batch 14 of
      // 20 is a fact somebody has to be able to act on.
      expect(burst, `batch ${batch}: ${burst.reasons.join(", ")}`).toMatchObject({
        ok: 6,
        added: 1,
        replayed: 5,
      });
      expect(burst.ids, `batch ${batch} handed out more than one unit`).toHaveLength(1);

      const { data: rows } = await director.read
        .from("units")
        .select("id")
        .eq("label_en", labelEn);
      expect(rows?.length, `batch ${batch} created more than one unit row`).toBe(1);
    }
  }, 120_000);
});

describe("what one counting unit contains", () => {
  it("makes two products of the same thing in two sizes", async () => {
    const name = `Sized Cement ${randomUUID().slice(0, 8)}`;

    for (const content of ["50 kg", "25 kg"]) {
      const result = await director.api.rpc("admin_add_product", {
        p_name: name,
        p_specification: null,
        p_unit_code: "bag",
        p_unit_content: content,
        p_idempotency_key: randomUUID(),
      });
      expect(result.data?.reason, `${content} was refused`).toBe("added");
    }

    const { data: rows } = await director.read
      .from("products")
      .select("unit_content")
      .eq("name", name);

    // Two products, to be stocked and priced separately (product.md §6.2).
    expect((rows ?? []).map((row) => row.unit_content).sort()).toEqual(["25 kg", "50 kg"]);
  });

  it("treats the same content typed differently as the same product", async () => {
    const name = `Same Content ${randomUUID().slice(0, 8)}`;

    const first = await director.api.rpc("admin_add_product", {
      p_name: name,
      p_specification: null,
      p_unit_code: "bag",
      p_unit_content: "50 kg",
      p_idempotency_key: randomUUID(),
    });
    expect(first.data?.reason).toBe("added");

    const duplicate = await director.api.rpc("admin_add_product", {
      p_name: name.toUpperCase(),
      p_specification: null,
      p_unit_code: "bag",
      p_unit_content: "  50   KG  ",
      p_idempotency_key: randomUUID(),
    });
    expect(duplicate.data?.reason).toBe("product_exists");
  });

  it("treats blank content and no content as one answer, not two", async () => {
    const name = `No Content ${randomUUID().slice(0, 8)}`;

    const first = await director.api.rpc("admin_add_product", {
      p_name: name,
      p_specification: null,
      p_unit_code: "piece",
      p_unit_content: null,
      p_idempotency_key: randomUUID(),
    });
    expect(first.data?.reason).toBe("added");

    const blank = await director.api.rpc("admin_add_product", {
      p_name: name,
      p_specification: null,
      p_unit_code: "piece",
      p_unit_content: "   ",
      p_idempotency_key: randomUUID(),
    });
    expect(blank.data?.reason).toBe("product_exists");

    const { data: rows } = await director.read
      .from("products")
      .select("unit_content")
      .eq("name", name);
    expect(rows?.length).toBe(1);
    // Stored as null rather than as an empty string, so identity has one spelling of "none".
    expect(rows?.[0].unit_content).toBeNull();
  });

  it("will not count a new product in a retired package-specific unit", async () => {
    const name = `Retired Unit ${randomUUID().slice(0, 8)}`;

    const result = await director.api.rpc("admin_add_product", {
      p_name: name,
      p_specification: null,
      p_unit_code: "bag_50kg",
      p_unit_content: null,
      p_idempotency_key: randomUUID(),
    });

    expect(result.data?.reason).toBe("unknown_unit");

    const { data: rows } = await director.read.from("products").select("id").eq("name", name);
    expect(rows).toEqual([]);
  });

  it("still resolves the four-argument call the deployed application makes", async () => {
    // The migration and the application release separately. Between the two, the live site is still
    // calling this with four arguments, and it has to keep working rather than break the Add
    // product screen for the length of a deploy.
    const name = `Four Argument ${randomUUID().slice(0, 8)}`;

    const result = await director.api.rpc("admin_add_product", {
      p_name: name,
      p_specification: null,
      p_unit_code: "piece",
      p_idempotency_key: randomUUID(),
    });

    expect(result.data?.reason, JSON.stringify(result.data)).toBe("added");
    expect(result.data.product).toMatchObject({ unit_content: null });
  });
});

describe("the catalogue that was already there", () => {
  it("is counted in generic units, with content recorded separately", async () => {
    const { data: rows } = await director.read
      .from("products")
      .select("name, unit_code, unit_content")
      .in("name", ["Dangote Cement 42R", "Sand", "Aggregate", "Timber 2 × 4", "Marine 18 mm"]);

    const byName = new Map((rows ?? []).map((row) => [row.name as string, row]));

    expect(byName.get("Dangote Cement 42R")).toMatchObject({
      unit_code: "bag",
      unit_content: "50 kg",
    });
    expect(byName.get("Sand")).toMatchObject({ unit_code: "bucket", unit_content: "20 litres" });
    expect(byName.get("Aggregate")).toMatchObject({
      unit_code: "bucket",
      unit_content: "20 litres",
    });
    expect(byName.get("Timber 2 × 4")).toMatchObject({ unit_code: "piece", unit_content: "12 ft" });
    // A sheet of marine ply is a sheet. Nothing acquired a content it never had.
    expect(byName.get("Marine 18 mm")).toMatchObject({ unit_code: "sheet", unit_content: null });
  });

  it("has no product left counted in a unit that also states an amount", async () => {
    const { data: units } = await director.read.from("units").select("code").eq("is_active", false);
    const retired = (units ?? []).map((row) => row.code as string);

    const { data: stranded } = await director.read
      .from("products")
      .select("name")
      .in("unit_code", retired);

    expect(stranded, "a product is still counted in a package-specific unit").toEqual([]);
  });
});
