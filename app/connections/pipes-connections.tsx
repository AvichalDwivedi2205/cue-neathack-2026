import { WorkOsWidgets, Pipes } from "@workos-inc/widgets";

export function PipesConnections({
  accessToken,
  shared,
}: {
  accessToken: string;
  shared: boolean;
}) {
  return (
    <WorkOsWidgets>
      <Pipes authToken={accessToken} enableSharedConnections={shared} />
    </WorkOsWidgets>
  );
}
