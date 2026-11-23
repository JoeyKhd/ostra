import { Suspense } from "react";

import { TrackersView } from "@/components/trackers/trackers-view";
import { t } from "@/lib/messages";
import { trackerPickerKinds } from "@/server/tracker-kinds";

export const metadata = { title: t("trackers.title") };

// Organization › Trackers (F-152; app-targets/m11-trackers/trackers.md): every member reads the
// list; connecting, changing and disconnecting are the organization admins' (`trackers.list` says
// which the reader is).
const TrackersPage = async () => {
  const kinds = await trackerPickerKinds();
  return (
    <Suspense>
      <TrackersView kinds={kinds} />
    </Suspense>
  );
};

export default TrackersPage;
