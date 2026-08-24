-- Schema for the order-history service: a reconstruction, no schema was provided -- see DECISIONS.md. Idempotent: safe to run repeatedly.

BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       text        NOT NULL,
  full_name   text        NOT NULL,
  -- CHECK, not enum: adding a role later is a constraint swap, not an ALTER TYPE.
  role        text        NOT NULL DEFAULT 'customer'
                          CHECK (role IN ('customer', 'admin')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness without the citext extension (needs superuser on some managed Postgres).
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));

CREATE TABLE IF NOT EXISTS orders (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status       text        NOT NULL
                            CHECK (status IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded')),
  -- Integer minor units, never float -- 0.1 + 0.2 is not 0.3.
  total_cents  bigint      NOT NULL CHECK (total_cents >= 0),
  currency     char(3)     NOT NULL CHECK (currency = upper(currency)),
  -- placed_at is the business event time; the endpoint sorts on this, not on created_at.
  placed_at    timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- THE index this endpoint lives on: column order mirrors the query, so it's a single index range scan with no sort node; id DESC is the tiebreaker placed_at alone can't give.
CREATE INDEX IF NOT EXISTS orders_user_placed_at_id_idx
  ON orders (user_id, placed_at DESC, id DESC);

-- Present because orders have line items; the list endpoint deliberately doesn't return them (see DECISIONS.md) -- expanding here is either an N+1 or an unbounded payload.
CREATE TABLE IF NOT EXISTS order_items (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    bigint      NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  sku         text        NOT NULL,
  description text        NOT NULL,
  quantity    integer     NOT NULL CHECK (quantity > 0),
  unit_cents  bigint      NOT NULL CHECK (unit_cents >= 0)
);

CREATE INDEX IF NOT EXISTS order_items_order_id_idx ON order_items (order_id);

COMMIT;
