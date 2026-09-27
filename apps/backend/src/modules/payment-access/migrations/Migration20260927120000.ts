import { Migration } from "@medusajs/framework/mikro-orm/migrations"

// Written by hand in the format `medusa db:generate` produces for this DML
// model (generation connects to the database, which was not authorized when
// this module was created). Not applied yet: running it requires explicit
// authorization (ADR-007).
export class Migration20260927120000 extends Migration {
  async up(): Promise<void> {
    this.addSql(
      `create table if not exists "payment_access_grant" ("id" text not null, "token_hash" text not null, "purpose" text check ("purpose" in ('pix_payment_view')) not null, "provider_id" text not null, "payment_method" text not null, "payment_session_id" text not null, "payment_collection_id" text not null, "cart_id" text not null, "expires_at" timestamptz not null, "revoked_at" timestamptz null, "revoked_reason" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "payment_access_grant_pkey" primary key ("id"));`
    )
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_payment_access_grant_deleted_at" ON "payment_access_grant" (deleted_at) WHERE deleted_at IS NULL;`
    )
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_payment_access_grant_token_hash_unique" ON "payment_access_grant" (token_hash) WHERE deleted_at IS NULL;`
    )
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_payment_access_grant_payment_session_id" ON "payment_access_grant" (payment_session_id) WHERE deleted_at IS NULL;`
    )
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_payment_access_grant_expires_at" ON "payment_access_grant" (expires_at) WHERE deleted_at IS NULL;`
    )
  }

  async down(): Promise<void> {
    this.addSql(`drop table if exists "payment_access_grant" cascade;`)
  }
}
