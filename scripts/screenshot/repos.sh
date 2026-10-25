#!/bin/bash
set -euo pipefail
D="$1"
C="$D/code"
R="$D/remotes"
rm -rf "$C" "$R"
mkdir -p "$C" "$R"

commit() {
    (cd "$1" && git add -A && GIT_AUTHOR_NAME="$2" GIT_AUTHOR_EMAIL="$3" GIT_COMMITTER_NAME="$2" GIT_COMMITTER_EMAIL="$3" \
        GIT_AUTHOR_DATE="$4" GIT_COMMITTER_DATE="$4" git commit -q --no-gpg-sign -m "$5")
}
remote() {
    git init -q --bare "$R/$2.git"
    (cd "$1" && git remote add origin "$R/$2.git" && git push -q -u origin main)
}

A="$C/checkout-api"
mkdir -p "$A"/{cmd/api,internal/webhooks,internal/store,internal/refunds,migrations}
cd "$A" && git init -q -b main
cat > go.mod <<'EOF'
module github.com/lumenpay/api

go 1.23
EOF
cat > Makefile <<'EOF'
.PHONY: dev test migrate

dev:
	@go run ./cmd/api

test:
	go test ./...

migrate:
	go run ./cmd/migrate up
EOF
cat > README.md <<'EOF'
# checkout-api

Payments and refunds API behind checkout.lumenpay.dev.

```
make dev      # API on :8080
make test
```
EOF
cat > internal/webhooks/event.go <<'EOF'
package webhooks

import "time"

type Event struct {
	ID        string
	Type      string
	Payload   []byte
	Attempts  int
	CreatedAt time.Time
}
EOF
cat > internal/webhooks/handler.go <<'EOF'
package webhooks

import (
	"context"
	"errors"
	"log/slog"
)

var ErrUnknownEvent = errors.New("webhooks: unknown event type")

type Processor interface {
	Process(ctx context.Context, ev Event) error
}

type Handler struct {
	proc Processor
	log  *slog.Logger
}

func NewHandler(proc Processor, log *slog.Logger) *Handler {
	return &Handler{proc: proc, log: log}
}

func (h *Handler) Deliver(ctx context.Context, ev Event) error {
	if err := h.proc.Process(ctx, ev); err != nil {
		h.log.Error("webhook failed", "event", ev.ID, "type", ev.Type, "err", err)
		return err
	}
	return nil
}
EOF
cat > internal/webhooks/handler_test.go <<'EOF'
package webhooks

import (
	"context"
	"io"
	"log/slog"
	"testing"
)

type okProc struct{ calls int }

func (p *okProc) Process(context.Context, Event) error { p.calls++; return nil }

func TestDeliverProcessesEvent(t *testing.T) {
	p := &okProc{}
	h := NewHandler(p, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := h.Deliver(context.Background(), Event{ID: "evt_1", Type: "charge.succeeded"}); err != nil {
		t.Fatal(err)
	}
	if p.calls != 1 {
		t.Fatalf("calls = %d, want 1", p.calls)
	}
}
EOF
cat > internal/refunds/refunds.go <<'EOF'
package refunds

import "errors"

var ErrAlreadyRefunded = errors.New("refunds: charge already refunded")

type Refund struct {
	ID       string
	ChargeID string
	Amount   int64
	Currency string
}

func Validate(r Refund, captured int64) error {
	if r.Amount <= 0 || r.Amount > captured {
		return errors.New("refunds: amount out of range")
	}
	return nil
}
EOF
cat > internal/refunds/refunds_test.go <<'EOF'
package refunds

import "testing"

func TestValidate(t *testing.T) {
	cases := []struct {
		amount, captured int64
		ok               bool
	}{
		{500, 1000, true},
		{1000, 1000, true},
		{0, 1000, false},
		{1500, 1000, false},
	}
	for _, c := range cases {
		err := Validate(Refund{Amount: c.amount}, c.captured)
		if (err == nil) != c.ok {
			t.Errorf("Validate(%d, %d) = %v", c.amount, c.captured, err)
		}
	}
}
EOF
cat > internal/store/store.go <<'EOF'
package store

import "database/sql"

type Store struct{ db *sql.DB }

func New(db *sql.DB) *Store { return &Store{db: db} }
EOF
cat > cmd/api/main.go <<'EOF'
package main

import (
	"log/slog"
	"net/http"
	"os"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	log.Info("listening", "addr", ":8080")
	if err := http.ListenAndServe(":8080", mux); err != nil {
		log.Error("server stopped", "err", err)
		os.Exit(1)
	}
}
EOF
cat > migrations/0005_refunds.sql <<'EOF'
CREATE TABLE refunds (
    id          text PRIMARY KEY,
    charge_id   text NOT NULL REFERENCES charges (id),
    amount      bigint NOT NULL,
    currency    char(3) NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
EOF
cat > migrations/0006_refunds_idempotency.sql <<'EOF'
ALTER TABLE refunds ADD COLUMN idempotency_key text UNIQUE;
EOF
commit "$A" "Maya Lindqvist" maya@lumenpay.dev "2026-09-02T10:14:00+03:00" "Initial checkout API skeleton"
remote "$A" checkout-api
echo '// TODO' >> internal/store/store.go
commit "$A" "Daniel Osei" daniel@lumenpay.dev "2026-09-18T15:42:00+03:00" "store: add refunds repository"
commit "$A" "Maya Lindqvist" maya@lumenpay.dev "2026-10-06T11:03:00+03:00" "refunds: reject amounts above the captured total" || true
sed -i '' 's|// TODO|func (s *Store) Ping() error { return s.db.Ping() }|' internal/store/store.go
commit "$A" "Onur Ravli" onur@onurravli.com "2026-10-14T17:21:00+03:00" "store: expose Ping for the health check"
git push -q
git checkout -q -b fix/webhook-retries
cat > internal/webhooks/retry.go <<'EOF'
package webhooks

import (
	"math/rand/v2"
	"time"
)

type Backoff struct {
	Base   time.Duration
	Max    time.Duration
	Jitter float64
}

var DefaultBackoff = Backoff{Base: 2 * time.Second, Max: 10 * time.Minute, Jitter: 0.2}

func (b Backoff) Delay(attempt int) time.Duration {
	d := b.Base << attempt
	if d <= 0 || d > b.Max {
		d = b.Max
	}
	j := 1 + b.Jitter*(2*rand.Float64()-1)
	return time.Duration(float64(d) * j)
}
EOF
cat > internal/webhooks/retry_test.go <<'EOF'
package webhooks

import (
	"testing"
	"time"
)

func TestBackoffGrows(t *testing.T) {
	b := Backoff{Base: time.Second, Max: time.Minute}
	for attempt, want := range []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second} {
		if got := b.Delay(attempt); got != want {
			t.Errorf("Delay(%d) = %v, want %v", attempt, got, want)
		}
	}
}

func TestBackoffCapsAtMax(t *testing.T) {
	b := Backoff{Base: time.Second, Max: time.Minute}
	if got := b.Delay(20); got != time.Minute {
		t.Errorf("Delay(20) = %v, want %v", got, time.Minute)
	}
}

func TestBackoffJitterStaysInRange(t *testing.T) {
	b := Backoff{Base: 10 * time.Second, Max: time.Hour, Jitter: 0.2}
	for i := 0; i < 1000; i++ {
		d := b.Delay(1)
		if d < 16*time.Second || d > 24*time.Second {
			t.Fatalf("Delay(1) = %v, outside ±20%% of 20s", d)
		}
	}
}
EOF
commit "$A" "Onur Ravli" onur@onurravli.com "2026-10-17T09:48:00+03:00" "webhooks: add exponential backoff with jitter"
git push -q -u origin fix/webhook-retries
cat > internal/webhooks/deadletter.go <<'EOF'
package webhooks

import (
	"context"
	"time"
)

type DeadLetter struct {
	EventID   string
	Type      string
	Attempts  int
	LastError string
	FailedAt  time.Time
}

type DeadLetterStore interface {
	Put(ctx context.Context, dl DeadLetter) error
}
EOF
commit "$A" "Onur Ravli" onur@onurravli.com "2026-10-17T10:31:00+03:00" "webhooks: park events that run out of attempts"
cat > internal/webhooks/handler.go <<'EOF'
package webhooks

import (
	"context"
	"errors"
	"log/slog"
	"time"
)

var ErrUnknownEvent = errors.New("webhooks: unknown event type")

const MaxAttempts = 8

type Processor interface {
	Process(ctx context.Context, ev Event) error
}

type Handler struct {
	proc    Processor
	dead    DeadLetterStore
	backoff Backoff
	log     *slog.Logger
}

func NewHandler(proc Processor, log *slog.Logger) *Handler {
	return &Handler{proc: proc, backoff: DefaultBackoff, log: log}
}

func (h *Handler) Deliver(ctx context.Context, ev Event) error {
	err := h.proc.Process(ctx, ev)
	if err == nil {
		return nil
	}
	if errors.Is(err, ErrUnknownEvent) || ev.Attempts+1 >= MaxAttempts {
		return h.park(ctx, ev, err)
	}
	h.log.Warn("webhook failed, retrying", "event", ev.ID, "attempt", ev.Attempts+1, "in", h.backoff.Delay(ev.Attempts))
	return err
}

func (h *Handler) park(ctx context.Context, ev Event, cause error) error {
	if h.dead == nil {
		return cause
	}
	return h.dead.Put(ctx, DeadLetter{EventID: ev.ID, Type: ev.Type, Attempts: ev.Attempts + 1, LastError: cause.Error(), FailedAt: time.Now()})
}
EOF
cat > migrations/0007_webhook_dead_letters.sql <<'EOF'
CREATE TABLE webhook_dead_letters (
    event_id    text PRIMARY KEY,
    type        text NOT NULL,
    attempts    int NOT NULL,
    last_error  text NOT NULL,
    failed_at   timestamptz NOT NULL DEFAULT now()
);
EOF
echo "	mux.HandleFunc(\"POST /webhooks/stripe\", nil)" > /dev/null
cd "$A"

W="$C/web-dashboard"
mkdir -p "$W"/{app/settings/billing,app/invoices,components,pages/settings,lib}
cd "$W" && git init -q -b main
cat > package.json <<'EOF'
{
  "name": "web-dashboard",
  "private": true,
  "scripts": {
    "dev": "next dev --turbopack",
    "build": "next build",
    "test": "vitest run",
    "lint": "next lint"
  },
  "dependencies": {
    "next": "15.5.4",
    "react": "19.1.1",
    "react-dom": "19.1.1",
    "@tanstack/react-table": "8.21.3"
  },
  "devDependencies": {
    "typescript": "5.9.2",
    "vitest": "3.2.4"
  }
}
EOF
cat > pages/settings/index.tsx <<'EOF'
import { SettingsLayout } from '../../components/SettingsLayout';

export default function SettingsPage() {
    return <SettingsLayout title="Settings" />;
}
EOF
cat > pages/settings/billing.tsx <<'EOF'
import { getServerSideProps as withSession } from '../../lib/session';
import { BillingForm } from '../../components/BillingForm';

export const getServerSideProps = withSession;

export default function BillingSettings({ account }: { account: { id: string } }) {
    return <BillingForm accountId={account.id} />;
}
EOF
cat > components/SettingsLayout.tsx <<'EOF'
export function SettingsLayout({ title }: { title: string }) {
    return <h1>{title}</h1>;
}
EOF
cat > components/BillingForm.tsx <<'EOF'
export function BillingForm({ accountId }: { accountId: string }) {
    return <form data-account={accountId} />;
}
EOF
cat > components/InvoiceTable.tsx <<'EOF'
export function InvoiceTable() {
    return <table />;
}
EOF
cat > lib/session.ts <<'EOF'
export async function getServerSideProps() {
    return { props: { account: { id: 'acct_demo' } } };
}
EOF
commit "$W" "Priya Raman" priya@lumenpay.dev "2026-08-21T13:05:00+03:00" "Dashboard with settings and invoices"
remote "$W" web-dashboard
git checkout -q -b feat/settings-app-router
cat > app/settings/page.tsx <<'EOF'
import { SettingsLayout } from '@/components/SettingsLayout';

export default function SettingsPage() {
    return <SettingsLayout title="Settings" />;
}
EOF
git rm -q pages/settings/index.tsx
commit "$W" "Onur Ravli" onur@onurravli.com "2026-10-16T16:12:00+03:00" "settings: move the index page to the App Router"
git push -q -u origin feat/settings-app-router
cat > app/settings/billing/page.tsx <<'EOF'
import { getAccount } from '@/lib/session';
import { BillingForm } from '@/components/BillingForm';

export default async function BillingSettings() {
    const account = await getAccount();
    return <BillingForm accountId={account.id} />;
}
EOF
git rm -q pages/settings/billing.tsx
cat > app/settings/layout.tsx <<'EOF'
export default function Layout({ children }: { children: React.ReactNode }) {
    return <section className="settings">{children}</section>;
}
EOF

I="$C/infra"
mkdir -p "$I"/{modules/rds,envs/staging,envs/production}
cd "$I" && git init -q -b main
cat > modules/rds/main.tf <<'EOF'
resource "aws_db_instance" "this" {
  identifier              = var.name
  engine                  = "postgres"
  engine_version          = "15.8"
  instance_class          = var.instance_class
  allocated_storage       = var.storage_gb
  backup_retention_period = 7
  deletion_protection     = true
}
EOF
cat > modules/rds/variables.tf <<'EOF'
variable "name" { type = string }
variable "instance_class" { type = string }
variable "storage_gb" { type = number }
EOF
cat > envs/staging/main.tf <<'EOF'
module "db" {
  source         = "../../modules/rds"
  name           = "checkout-staging"
  instance_class = "db.t4g.medium"
  storage_gb     = 100
}
EOF
cp envs/staging/main.tf envs/production/main.tf
sed -i '' 's/checkout-staging/checkout-production/; s/db.t4g.medium/db.r7g.xlarge/; s/100/500/' envs/production/main.tf
commit "$I" "Daniel Osei" daniel@lumenpay.dev "2026-07-30T09:40:00+03:00" "RDS module for checkout"
remote "$I" infra
git checkout -q -b chore/rds-postgres-16
sed -i '' 's/"15.8"/"16.4"/' modules/rds/main.tf
cat >> modules/rds/main.tf <<'EOF'

resource "aws_db_parameter_group" "this" {
  name   = "${var.name}-pg16"
  family = "postgres16"
}
EOF

