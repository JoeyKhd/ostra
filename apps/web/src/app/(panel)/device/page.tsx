import { Suspense } from "react";

import { DeviceApproval } from "@/components/runners/device-approval";
import { t } from "@/lib/messages";

export const metadata = { title: t("device.title") };

const DevicePage = () => (
  <Suspense>
    <DeviceApproval />
  </Suspense>
);

export default DevicePage;
