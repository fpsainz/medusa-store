import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260930030200 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "mercadopago_card_attempt" drop constraint if exists "mercadopago_card_attempt_mp_order_unique";`);
    this.addSql(`alter table if exists "mercadopago_card_attempt" drop constraint if exists "mercadopago_card_attempt_external_reference_unique";`);
    this.addSql(`create table if not exists "mercadopago_card_attempt" ("id" text not null, "payment_session_id" text not null, "cart_id" text not null, "state" text check ("state" in ('submitted', 'authorizing', 'unknown', 'resolved', 'failed', 'replaced', 'expired')) not null, "external_reference" text not null, "body_sha256" text null, "encrypted_card_token" text null, "token_destroyed_at" timestamptz null, "mercadopago_order_id" text null, "last_error_class" text null, "authorization_started_at" timestamptz null, "authorizing_at" timestamptz null, "ended_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "mercadopago_card_attempt_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_mercadopago_card_attempt_deleted_at" ON "mercadopago_card_attempt" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_mercadopago_card_attempt_one_live_per_session" ON "mercadopago_card_attempt" ("payment_session_id") WHERE state IN ('submitted', 'authorizing', 'unknown', 'expired') AND deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_mercadopago_card_attempt_payment_session_id" ON "mercadopago_card_attempt" ("payment_session_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_mercadopago_card_attempt_external_reference_unique" ON "mercadopago_card_attempt" ("external_reference") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_mercadopago_card_attempt_mp_order_unique" ON "mercadopago_card_attempt" ("mercadopago_order_id") WHERE mercadopago_order_id IS NOT NULL AND deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_mercadopago_card_attempt_state" ON "mercadopago_card_attempt" ("state") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "mercadopago_card_attempt" cascade;`);
  }

}
