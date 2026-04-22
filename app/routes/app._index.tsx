import { redirect } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { Page, Layout, Card, Text, BlockStack } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getSupabaseForStore } from "../lib/supabase.server.js";

const STEP_ROUTES: Record<number, string> = {
  1: "/app/onboarding/step1-postex",
  2: "/app/onboarding/step2-meta",
  3: "/app/onboarding/step3-cogs",
  4: "/app/onboarding/step4-expenses",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const supabase = await getSupabaseForStore(shop);

  const { data: store } = await supabase
    .from("stores")
    .select("onboarding_complete, onboarding_step")
    .eq("store_id", shop)
    .single();

  if (!store) {
    // Fallback: afterAuth hook should have created this row, but handle gracefully
    return redirect("/app/onboarding/step1-postex");
  }

  if (!store.onboarding_complete) {
    return redirect(
      STEP_ROUTES[store.onboarding_step] ?? "/app/onboarding/step1-postex"
    );
  }

  // Onboarding complete — dashboard data loaded in Task 7
  return { shop };
};

export default function Index() {
  return (
    <Page>
      <TitleBar title="COD Tracker" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Dashboard
              </Text>
              <Text as="p" variant="bodyMd">
                Your analytics dashboard is being built. Check back soon.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
