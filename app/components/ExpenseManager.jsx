import { useState, useEffect } from "react";
import { Form, useNavigation } from "@remix-run/react";
import {
  Card,
  BlockStack,
  InlineStack,
  Box,
  Text,
  TextField,
  Select,
  Button,
  Banner,
  Badge,
  Divider,
  Modal,
  ChoiceList,
  Icon,
  ActionList,
  Popover,
} from "@shopify/polaris";
import {
  CalendarIcon,
  CalendarTimeIcon,
  PackageIcon,
  CashDollarIcon,
  PlusIcon,
  MenuHorizontalIcon,
  ReceiptIcon,
} from "@shopify/polaris-icons";
import { formatMoney } from "../lib/format.js";

// ── helpers ──────────────────────────────────────────────────────────────────
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function monthLabel(yyyyMM) {
  const [y, m] = String(yyyyMM).split("-").map(Number);
  return `${MONTHS[(m || 1) - 1]} ${y}`;
}
function currentYM() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`;
}
// this month + the 2 prior, for the "stop after" picker.
function stopMonthOptions() {
  const d = new Date();
  const opts = [];
  for (let i = 0; i < 3; i++) {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    opts.push({ label: `${MONTHS[m - 1]} ${y}`, value: `${y}-${m}` });
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return opts;
}

const KIND_OPTIONS = [
  { value: "fixed",     label: "Fixed monthly",        help: "Same amount every month — rent, salary." },
  { value: "variable",  label: "Changes monthly",      help: "You set the amount each month — e.g. shipping." },
  { value: "per_order", label: "Per delivered order",  help: "Multiplied by delivered orders — packaging." },
  { value: "percent",   label: "% of ad spend / sales", help: "A percentage — payment / gateway fees." },
];

// One source of truth for how each kind is presented (icon, colour, label,
// one-line summary). Keeps the row, badge and icon-chip consistent.
function kindMeta(e, currency) {
  const money = (n) => formatMoney(n, currency, { nullDisplay: "—" });
  if (e.kind === "per_order")
    return { label: "Per order", tone: "success", bg: "bg-surface-success",
             iconTone: "success", icon: PackageIcon,
             summary: `${money(e.amount)} · per delivered order` };
  if (e.kind === "percent")
    return { label: "% fee", tone: "magic", bg: "bg-surface-magic",
             iconTone: "magic", icon: CashDollarIcon,
             summary: `${Number(e.amount)}% of ${e.pctBase === "net_sales" ? "net sales" : "ad spend"}` };
  if (e.isVariable)
    return { label: "Monthly", tone: "attention", bg: "bg-surface-caution",
             iconTone: "caution", icon: CalendarTimeIcon,
             summary: `${money(e.amount)} · changes monthly` };
  return { label: "Fixed", tone: "info", bg: "bg-surface-info",
           iconTone: "info", icon: CalendarIcon,
           summary: `${money(e.amount)} · every month` };
}

// ── Add / Edit form body (shared inside a Modal) ─────────────────────────────
function ExpenseFields({ currency }) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState("fixed");
  const [pctBase, setPctBase] = useState("ad_spend");

  const amountLabel =
    kind === "percent"   ? "Percentage" :
    kind === "per_order" ? `Amount per order (${currency})` :
    kind === "variable"  ? `This month's amount (${currency})` :
    `Monthly amount (${currency})`;

  return (
    <BlockStack gap="400">
      <TextField
        label="Name"
        name="name"
        value={name}
        onChange={setName}
        placeholder="e.g. Warehouse rent"
        autoComplete="off"
        requiredIndicator
      />
      <Select
        label="Type"
        name="kind"
        options={KIND_OPTIONS.map((k) => ({ label: k.label, value: k.value }))}
        value={kind}
        onChange={setKind}
        helpText={KIND_OPTIONS.find((k) => k.value === kind)?.help}
      />
      <InlineStack gap="300" blockAlign="end" wrap={false}>
        <Box width="100%">
          <TextField
            label={amountLabel}
            name="amount"
            type="number"
            min="0"
            step="any"
            value={amount}
            onChange={setAmount}
            autoComplete="off"
            suffix={kind === "percent" ? "%" : undefined}
          />
        </Box>
        {kind === "percent" && (
          <Box minWidth="170px">
            <Select
              label="Applied to"
              name="pct_base"
              options={[
                { label: "Ad spend", value: "ad_spend" },
                { label: "Net sales", value: "net_sales" },
              ]}
              value={pctBase}
              onChange={setPctBase}
            />
          </Box>
        )}
      </InlineStack>
    </BlockStack>
  );
}

function AddModal({ currency, onClose, submitting, error }) {
  return (
    <Modal
      open
      onClose={onClose}
      title="Add an expense"
      primaryAction={{ content: "Add expense", submit: true, formId: "add-expense-form", loading: submitting }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
    >
      <Modal.Section>
        <Form method="post" id="add-expense-form">
          <input type="hidden" name="intent" value="expense_add" />
          {error && <Box paddingBlockEnd="300"><Banner tone="critical">{error}</Banner></Box>}
          <ExpenseFields currency={currency} />
        </Form>
      </Modal.Section>
    </Modal>
  );
}

// ── Edit amount modal ────────────────────────────────────────────────────────
function EditModal({ expense, currency, onClose, submitting, error }) {
  const [amount, setAmount] = useState(String(expense.amount));
  const [mode, setMode] = useState(["forward"]);
  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit “${expense.name}”`}
      primaryAction={{ content: "Save", loading: submitting, submit: true, formId: "edit-expense-form" }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
    >
      <Modal.Section>
        <Form method="post" id="edit-expense-form">
          <input type="hidden" name="intent" value="expense_edit_amount" />
          <input type="hidden" name="series_id" value={expense.seriesId} />
          <input type="hidden" name="mode" value={mode[0]} />
          <BlockStack gap="400">
            {error && <Banner tone="critical">{error}</Banner>}
            <TextField
              label={`New amount${expense.kind === "percent" ? " (%)" : ` (${currency})`}`}
              name="amount"
              type="number"
              min="0"
              step="any"
              value={amount}
              onChange={setAmount}
              autoComplete="off"
            />
            {expense.kind === "fixed" && (
              <ChoiceList
                title="Apply"
                selected={mode}
                onChange={setMode}
                choices={[
                  { label: "From this month on", value: "forward",
                    helpText: "Past months keep the old amount." },
                  { label: "Fix a past typo", value: "fix",
                    helpText: "Overwrites the current value everywhere." },
                ]}
              />
            )}
          </BlockStack>
        </Form>
      </Modal.Section>
    </Modal>
  );
}

// ── Remove modal (stop after a month, or delete outright) ────────────────────
function RemoveModal({ expense, onClose, submitting, error }) {
  const [choice, setChoice] = useState(["stop"]);
  const opts = stopMonthOptions();
  const [stopMonth, setStopMonth] = useState(opts[0].value);
  const isStop = choice[0] === "stop";
  return (
    <Modal
      open
      onClose={onClose}
      title={`Remove “${expense.name}”`}
      primaryAction={{
        content: isStop ? "Stop expense" : "Delete permanently",
        destructive: !isStop,
        loading: submitting,
        submit: true,
        formId: "remove-expense-form",
      }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
    >
      <Modal.Section>
        <Form method="post" id="remove-expense-form">
          <input
            type="hidden"
            name="intent"
            value={isStop ? "expense_stop" : "expense_delete"}
          />
          <input type="hidden" name="series_id" value={expense.seriesId} />
          {isStop && <input type="hidden" name="stop_month" value={stopMonth} />}
          <BlockStack gap="400">
            {error && <Banner tone="critical">{error}</Banner>}
            <ChoiceList
              title=""
              titleHidden
              selected={choice}
              onChange={setChoice}
              choices={[
                { label: "Stop it after a month", value: "stop",
                  helpText: "Keeps past months correct — just ends it." },
                { label: "Delete completely", value: "delete",
                  helpText: "Also removes it from past periods." },
              ]}
            />
            {isStop && (
              <Select
                label="Last active month"
                options={opts}
                value={stopMonth}
                onChange={setStopMonth}
              />
            )}
          </BlockStack>
        </Form>
      </Modal.Section>
    </Modal>
  );
}

// ── Monthly nudge for variable expenses ──────────────────────────────────────
function MonthlyNudge({ items, currency, submitting }) {
  if (items.length === 0) return null;
  return (
    <Banner tone="attention" title={`Confirm ${monthLabel(currentYM())} costs`}>
      <BlockStack gap="300">
        {items.map((e) => (
          <Form method="post" key={e.seriesId}>
            <input type="hidden" name="intent" value="expense_set_month" />
            <input type="hidden" name="series_id" value={e.seriesId} />
            <InlineStack gap="300" blockAlign="end" wrap={false}>
              <Box width="100%">
                <TextField
                  label={e.name}
                  name="amount"
                  type="number"
                  min="0"
                  step="any"
                  defaultValue={String(e.amount)}
                  autoComplete="off"
                  prefix={currency}
                />
              </Box>
              <Button submit variant="primary" loading={submitting}>Save</Button>
            </InlineStack>
          </Form>
        ))}
      </BlockStack>
    </Banner>
  );
}

// ── One expense row ──────────────────────────────────────────────────────────
function ExpenseRow({ e, currency, onEdit, onRemove }) {
  const [menu, setMenu] = useState(false);
  const m = kindMeta(e, currency);
  return (
    <Box paddingBlock="300">
      <InlineStack align="space-between" blockAlign="center" wrap={false} gap="300">
        <InlineStack gap="300" blockAlign="center" wrap={false}>
          <Box background={m.bg} padding="200" borderRadius="full">
            <Icon source={m.icon} tone={m.iconTone} />
          </Box>
          <BlockStack gap="050">
            <InlineStack gap="200" blockAlign="center">
              <Text as="span" variant="bodyMd" fontWeight="semibold">{e.name}</Text>
              {e.needsThisMonth && (
                <Badge tone="attention" size="small">{`Needs ${monthLabel(currentYM())}`}</Badge>
              )}
            </InlineStack>
            <InlineStack gap="150" blockAlign="center">
              <Badge tone={m.tone} size="small">{m.label}</Badge>
              <Text as="span" variant="bodySm" tone="subdued">{m.summary}</Text>
            </InlineStack>
          </BlockStack>
        </InlineStack>
        <Popover
          active={menu}
          onClose={() => setMenu(false)}
          activator={
            <Button
              variant="tertiary"
              icon={MenuHorizontalIcon}
              accessibilityLabel={`Actions for ${e.name}`}
              onClick={() => setMenu((v) => !v)}
            />
          }
        >
          <ActionList
            actionRole="menuitem"
            items={[
              { content: "Edit amount", onAction: () => { setMenu(false); onEdit(e); } },
              { content: "Remove", destructive: true, onAction: () => { setMenu(false); onRemove(e); } },
            ]}
          />
        </Popover>
      </InlineStack>
    </Box>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
// Props:
//   expenses   summarized list from summarizeExpenses() (server)
//   currency   string
//   actionData last action result ({ intent, success?, error? })
//   title / subtitle optional copy
/**
 * @param {Object} props
 * @param {Array<any>} [props.expenses]
 * @param {string} [props.currency]
 * @param {any} [props.actionData]
 * @param {string} [props.title]
 * @param {string} [props.subtitle]
 */
export default function ExpenseManager({
  expenses = [],
  currency = "PKR",
  actionData,
  title = "Business expenses",
  subtitle,
}) {
  const nav = useNavigation();
  const submitting = nav.state === "submitting";
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);

  // Close overlays once a mutation finishes successfully.
  useEffect(() => {
    if (nav.state === "idle" && actionData?.success) {
      setAdding(false);
      setEditing(null);
      setRemoving(null);
    }
  }, [nav.state, actionData]);

  const needMonth = expenses.filter((e) => e.needsThisMonth);
  const err = actionData?.error ?? null;

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
          <BlockStack gap="050">
            <Text as="h2" variant="headingMd">{title}</Text>
            {subtitle && (
              <Text as="p" variant="bodySm" tone="subdued">{subtitle}</Text>
            )}
          </BlockStack>
          {expenses.length > 0 && (
            <Button variant="primary" icon={PlusIcon} onClick={() => setAdding(true)}>
              Add expense
            </Button>
          )}
        </InlineStack>

        {err && !adding && !editing && !removing && (
          <Banner tone="critical">{err}</Banner>
        )}

        <MonthlyNudge items={needMonth} currency={currency} submitting={submitting} />

        {expenses.length > 0 ? (
          <BlockStack gap="0">
            {expenses.map((e, i) => (
              <Box key={e.seriesId}>
                {i > 0 && <Divider />}
                <ExpenseRow
                  e={e}
                  currency={currency}
                  onEdit={setEditing}
                  onRemove={setRemoving}
                />
              </Box>
            ))}
          </BlockStack>
        ) : (
          <Box paddingBlock="500">
            <BlockStack gap="300" inlineAlign="center">
              <Box background="bg-surface-secondary" padding="400" borderRadius="full">
                <Icon source={ReceiptIcon} tone="subdued" />
              </Box>
              <BlockStack gap="100" inlineAlign="center">
                <Text as="h3" variant="headingSm">No expenses yet</Text>
                <Text as="p" variant="bodySm" tone="subdued" alignment="center">
                  Add rent, packaging and fees to see your true net profit.
                </Text>
              </BlockStack>
              <Button variant="primary" icon={PlusIcon} onClick={() => setAdding(true)}>
                Add your first expense
              </Button>
            </BlockStack>
          </Box>
        )}
      </BlockStack>

      {adding && (
        <AddModal
          currency={currency}
          submitting={submitting}
          error={err}
          onClose={() => setAdding(false)}
        />
      )}
      {editing && (
        <EditModal
          expense={editing}
          currency={currency}
          submitting={submitting}
          error={err}
          onClose={() => setEditing(null)}
        />
      )}
      {removing && (
        <RemoveModal
          expense={removing}
          submitting={submitting}
          error={err}
          onClose={() => setRemoving(null)}
        />
      )}
    </Card>
  );
}
