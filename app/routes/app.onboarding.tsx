import type { LoaderFunctionArgs } from "@remix-run/node";
import { Outlet, useLocation } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

const STEPS = [
  { num: 1, slug: "step1", label: "PostEx" },
  { num: 2, slug: "step2", label: "Meta Ads" },
  { num: 3, slug: "step3", label: "COGS" },
  { num: 4, slug: "step4", label: "Expenses" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function OnboardingLayout() {
  const location = useLocation();
  const currentStep =
    STEPS.find(s => location.pathname.includes(s.slug))?.num ?? 1;

  return (
    <Page>
      <TitleBar title="Setup" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Getting Started — Step {currentStep} of 4
              </Text>
              <InlineStack gap="200">
                {STEPS.map(s => (
                  <Badge
                    key={String(s.num)}
                    tone={
                      s.num < currentStep
                        ? "success"
                        : s.num === currentStep
                        ? "attention"
                        : undefined
                    }
                  >
                    {`${s.num}. ${s.label}`}
                  </Badge>
                ))}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section>
          <Outlet />
        </Layout.Section>
      </Layout>
    </Page>
  );
}
