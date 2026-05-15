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
  Popover,
  ChoiceList,
} from "@shopify/polaris";

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
// Build a small set of stop-after options: this month + the 2 prior.
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
  { value: "fixed",     label: "Fixed monthly",       help: "Same amount every month (rent, salary)." },
  { value: "variable",  label: "Changes monthly",     help: "You set the amount each month (e.g. shipping)." },
  { value: "per_order", label: "Per delivered order", help: "Multiplied by delivered orders (packaging)." },
  { value: "percent",   label: "% of ad spend / sales", help: "A percentage (payment / gateway fees)." },
];

function kindSummary(e, currency) {
  const money = (n) => `${currency} ${Number(n).toLocaleString()}`;
  if (e.kind === "per_order") return `Per delivered order · ${money(e.amount)}`;
  if (e.kind === "percent")
    return `${Number(e.amount)}% of ${e.pctBase === "net_sales" ? "net sales" : "ad spend"}`;
  if (e.isVariable) return `Changes monthly · now ${money(e.amount)}`;
  return `Fixed monthly · ${money(e.amount)}`;
}

// ── Add form ─────────────────────────────────────────────────────────────────
function AddExpense({ currency, submitting }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("fixed");
  const [amount, setAmount] = useState("0");
  const [pctBase, setPctBase] = useState("ad_spend");
  const nav = useNavigation();
  const adding = submitting && nav.formData?.get("intent") === "expense_add";

  const amountLabel =
    kind === "percent" ? "Percent" :
    kind === "per_order" ? `Amount per order (${currency})` :
    kind === "variable" ? `This month's amount (${currency})` :
    `Monthly amount (${currency})`;

  return (
    <Form method="post" onSubmit={() => { setName(""); setAmount("0"); }}>
      <input type="hidden" name="intent" value="expense_add" />
      <BlockStack gap="300">
        <TextField
          label="Name"
          name="name"
          value={name}
          onChange={setName}
          placeholder="e.g. Warehouse rent"
          autoComplete="off"
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
        <InlineStack align="start">
          <Button submit variant="primary" loading={adding}>Add expense</Button>
        </InlineStack>
      </BlockStack>
    </Form>
  );
}

// ── Edit amount modal ────────────────────────────────────────────────────────
function EditModal({ expense, currency, onClose, submitting }) {
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

// ── Remove popover ───────────────────────────────────────────────────────────
function RemovePopover({ expense, onClose, submitting }) {
  const [choice, setChoice] = useState(["stop"]);
  const opts = stopMonthOptions();
  const [stopMonth, setStopMonth] = useState(opts[0].value);
  const isStop = choice[0] === "stop";
  return (
    <Popover.Pane>
      <Box padding="400" minWidth="320px">
        <Form method="post" onSubmit={onClose}>
          <input
            type="hidden"
            name="intent"
            value={isStop ? "expense_stop" : "expense_delete"}
          />
          <input type="hidden" name="series_id" value={expense.seriesId} />
          {isStop && <input type="hidden" name="stop_month" value={stopMonth} />}
          <BlockStack gap="300">
            <Text as="p" variant="headingSm">Remove “{expense.name}”?</Text>
            <ChoiceList
              title=""
              titleHidden
              selected={choice}
              onChange={setChoice}
              choices={[
                { label: "Stop it after a month", value: "stop",
                  helpText: "Keeps past months correct; just ends it." },
                { label: "Delete completely", value: "delete",
                  helpText: "Also removes it from past periods." },
              ]}
            />
            {isStop && (
              <Select
                label="Last active month"
                labelHidden
                options={opts}
                value={stopMonth}
                onChange={setStopMonth}
              />
            )}
            <InlineStack align="end" gap="200">
              <Button onClick={onClose}>Cancel</Button>
              <Button
                submit
                variant="primary"
                tone={isStop ? undefined : "critical"}
                loading={submitting}
              >
                {isStop ? "Stop expense" : "Delete"}
              </Button>
            </InlineStack>
          </BlockStack>
        </Form>
      </Box>
    </Popover.Pane>
  );
}

// ── Monthly nudge for variable expenses ──────────────────────────────────────
function MonthlyNudge({ items, currency, submitting }) {
  if (items.length === 0) return null;
  return (
    <Banner tone="attention" title={`Confirm this month's costs — ${monthLabel(currentYM())}`}>
      <BlockStack gap="300">
        <Text as="p" variant="bodySm" tone="subdued">
          These change every month. We're showing last month's value as an
          estimate until you confirm.
        </Text>
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
                  helpText={`Last set: ${currency} ${Number(e.amount).toLocaleString()}`}
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

// ── Main ─────────────────────────────────────────────────────────────────────
// Props:
//   expenses  summarized list from summarizeExpenses() (server)
//   currency  string
//   actionData last action result ({ intent, success?, error? })
//   title / subtitle optional copy
export default function ExpenseManager({
  expenses = [],
  currency = "PKR",
  actionData,
  title = "Business expenses",
  subtitle = "Fixed costs, per-order costs and percentage fees. Used to compute your true net profit.",
}) {
  const nav = useNavigation();
  const submitting = nav.state === "submitting";
  const [editing, setEditing] = useState(null);
  const [removingFor, setRemovingFor] = useState(null);

  // Close overlays once a mutation finishes.
  useEffect(() => {
    if (nav.state === "idle" && actionData?.success) {
      setEditing(null);
      setRemovingFor(null);
    }
  }, [nav.state, actionData]);

  const needMonth = expenses.filter((e) => e.needsThisMonth);

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">{title}</Text>
          <Text as="p" variant="bodySm" tone="subdued">{subtitle}</Text>
        </BlockStack>

        {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}

        <MonthlyNudge items={needMonth} currency={currency} submitting={submitting} />

        {expenses.length > 0 ? (
          <BlockStack gap="0">
            {expenses.map((e, i) => (
              <Box key={e.seriesId}>
                {i > 0 && <Divider />}
                <Box paddingBlock="300">
                  <InlineStack align="space-between" blockAlign="center" wrap={false}>
                    <BlockStack gap="050">
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          {e.name}
                        </Text>
                        {e.isVariable && <Badge tone="info" size="small">Monthly</Badge>}
                        {e.needsThisMonth && <Badge tone="attention" size="small">needs {monthLabel(currentYM())}</Badge>}
                      </InlineStack>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {kindSummary(e, currency)}
                      </Text>
                    </BlockStack>
                    <InlineStack gap="200" blockAlign="center">
                      <Button variant="plain" onClick={() => setEditing(e)}>Edit</Button>
                      <Popover
                        active={removingFor === e.seriesId}
                        onClose={() => setRemovingFor(null)}
                        activator={
                          <Button
                            variant="plain"
                            tone="critical"
                            onClick={() => setRemovingFor(e.seriesId)}
                          >
                            Remove
                          </Button>
                        }
                      >
                        <RemovePopover
                          expense={e}
                          submitting={submitting}
                          onClose={() => setRemovingFor(null)}
                        />
                      </Popover>
                    </InlineStack>
                  </InlineStack>
                </Box>
              </Box>
            ))}
          </BlockStack>
        ) : (
          <Text as="p" variant="bodySm" tone="subdued">
            No expenses yet. Add your first one below.
          </Text>
        )}

        <Divider />

        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">Add an expense</Text>
          <AddExpense currency={currency} submitting={submitting} />
        </BlockStack>
      </BlockStack>

      {editing && (
        <EditModal
          expense={editing}
          currency={currency}
          submitting={submitting}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}
