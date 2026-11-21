#!/usr/bin/env bash
# The `live-kind` proof job's steps (ticket 35, ADR 0061), on a fresh Linux machine with Docker:
# GitHub's `ubuntu-24.04` in `.github/workflows/proof.yml`, or anyone's own Linux box (run it from a
# clone after `pnpm install --frozen-lockfile && pnpm turbo run generate`). Two kind clusters: the
# newest Kubernetes kind supports, with Calico, which enforces NetworkPolicy; and Kubernetes 1.29,
# ostra's oldest, with flannel, which ignores it, so the control pod tells the two apart. Every tool
# is pinned by version and SHA-256 and every image by digest; no secret is used or printed.
#
#   scripts/live/kind.sh
#
# Each step ends in a RESULT line (scripts/live/lib.sh); what a hosted runner can't do, or what an
# unbuilt ticket holds, is a `not-run` line with its reason, and its condition stays `partial`.

cd "$(dirname "$0")/../.." || exit 1
. scripts/live/lib.sh

BIN="${RUNNER_TEMP:-/tmp}/ostra-live-bin"
mkdir -p "$BIN"
export PATH="$BIN:$PATH"
VERSION="$(node -p "require('./apps/runner/package.json').version")"
SERVER="ostra/server:$VERSION"
RUNNER="ostra/runner:$VERSION"
BASE="ostra/base:$VERSION"
POSTGRES_IMAGE="postgres:18.6-bookworm@sha256:f1ea2a1a4fb7b68d4836be1fdcb8a6466a89b072158bf9d97663600538c294c5"
BUSYBOX_IMAGE="busybox:1.37.0@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec"
REGISTRY_IMAGE="registry:3.0.0@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e"
HTPASSWD_IMAGE="httpd:2.4.65-alpine@sha256:07b2fabb7029a0b8aeb2e0fd02651c28fe22c21c5b5a59d6ff5b022791fcd89e"
# The live registry's test credential: made up for this run, valid only on this machine's registry.
REGISTRY_USER="ostra"
REGISTRY_TOKEN="ostra-live-registry"

# name kind-version kind-sha256 node-image cni
CLUSTERS=(
  "calico v0.33.0 aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5 calico"
  "flannel v0.27.0 a6875aaea358acf0ac07786b1a6755d08fd640f4c79b7a2e46681cc13f49a04b kindest/node:v1.29.14@sha256:8703bd94ee24e51b778d5556ae310c6c0fa67d761fae6379c8e0bb480e6fea29 flannel"
)
CALICO_URL="https://raw.githubusercontent.com/projectcalico/calico/v3.33.0/manifests/calico.yaml"
CALICO_SHA="2de8f47595fb9c41b3f47d7b767a1f8e72ecf84057af834738ff12689a234da5"
FLANNEL_URL="https://github.com/flannel-io/flannel/releases/download/v0.28.10/kube-flannel.yml"
FLANNEL_SHA="393bdbce53eb50c8eb97dd513b218518b7d6e7985dc7b889be956e112a711084"
HELM_URL="https://get.helm.sh/helm-v4.3.2-linux-amd64.tar.gz"
HELM_SHA="d1c0278d46beab79582d7e50f5b3dc206944ba8e577cde618513fd07daa53983"

say "live-kind on $(uname -srm), $(nproc) CPUs, $(free -g | awk '/Mem:/ {print $2}') GB, Docker $(docker version --format '{{.Server.Version}}'), images $VERSION"

tools() {
  local cluster kind_version kind_sha
  for cluster in "${CLUSTERS[@]}"; do
    read -r _ kind_version kind_sha _ _ <<<"$cluster"
    fetch_checked "https://github.com/kubernetes-sigs/kind/releases/download/$kind_version/kind-linux-amd64" "$kind_sha" "$BIN/kind-$kind_version" || return 1
    chmod +x "$BIN/kind-$kind_version"
  done
  fetch_checked "$HELM_URL" "$HELM_SHA" "$BIN/helm.tar.gz" || return 1
  tar -xzf "$BIN/helm.tar.gz" -C "$BIN" --strip-components=1 linux-amd64/helm || return 1
  fetch_checked "$CALICO_URL" "$CALICO_SHA" "$BIN/calico.yaml" || return 1
  fetch_checked "$FLANNEL_URL" "$FLANNEL_SHA" "$BIN/flannel.yml" || return 1
  helm version && kubectl version --client
}
step tools tools
step images-build pnpm images:build

# A registry on kind's Docker network, with Basic auth, that the clusters' nodes reach as
# `ostra-registry:5000` and this machine pushes to as `localhost:5001`.
registry_up() {
  docker network create kind >/dev/null 2>&1 || true
  mkdir -p "$BIN/registry-auth"
  docker run --rm --entrypoint htpasswd "$HTPASSWD_IMAGE" -Bbn "$REGISTRY_USER" "$REGISTRY_TOKEN" >"$BIN/registry-auth/htpasswd" || return 1
  docker run -d --name ostra-registry --network kind -p 127.0.0.1:5001:5000 -v "$BIN/registry-auth:/auth:ro" \
    -e REGISTRY_AUTH=htpasswd -e REGISTRY_AUTH_HTPASSWD_REALM=ostra-live -e REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd \
    "$REGISTRY_IMAGE" || return 1
  echo "$REGISTRY_TOKEN" | docker login localhost:5001 -u "$REGISTRY_USER" --password-stdin >/dev/null || return 1
  docker tag "$BASE" localhost:5001/ostra/live-base:1 && docker push localhost:5001/ostra/live-base:1 | tail -n 3
  docker logout localhost:5001 >/dev/null
}
step registry registry_up
BASE_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' localhost:5001/ostra/live-base:1 2>/dev/null | sed 's/.*@//')"

make_cluster() {
  local name="$1" kind_version="$2" image="$3" cni="$4" config
  config="$BIN/kind-$name.yaml"
  {
    echo "kind: Cluster"
    echo "apiVersion: kind.x-k8s.io/v1alpha4"
    if [ "$cni" != "kindnet" ]; then
      echo "networking:"
      echo "  disableDefaultCNI: true"
      echo "  podSubnet: 10.244.0.0/16"
    fi
    echo "containerdConfigPatches:"
    echo "  - |-"
    echo "    [plugins.\"io.containerd.grpc.v1.cri\".registry.mirrors.\"localhost:5001\"]"
    echo "      endpoint = [\"http://ostra-registry:5000\"]"
  } >"$config"
  "kind-$kind_version" create cluster --name "$name" --image "$image" --config "$config" --wait 0s || return 1
  case "$cni" in
    calico) kubectl --context "kind-$name" apply -f "$BIN/calico.yaml" >/dev/null || return 1 ;;
    flannel) kubectl --context "kind-$name" apply -f "$BIN/flannel.yml" >/dev/null || return 1 ;;
  esac
  kubectl --context "kind-$name" wait --for=condition=Ready nodes --all --timeout=300s || return 1
  kubectl --context "kind-$name" version
  for image in "$SERVER" "$RUNNER" "$BASE"; do "kind-$kind_version" load docker-image --name "$name" "$image" >/dev/null || return 1; done
}

server_chart() {
  local ctx="kind-$1" forward code
  kubectl --context "$ctx" create namespace ostra || return 1
  kubectl --context "$ctx" -n ostra run postgres --image "$POSTGRES_IMAGE" --env POSTGRES_USER=ostra --env POSTGRES_DB=ostra --env POSTGRES_HOST_AUTH_METHOD=trust --port 5432 --labels app=postgres || return 1
  kubectl --context "$ctx" -n ostra expose pod postgres --port 5432 || return 1
  kubectl --context "$ctx" -n ostra wait --for=condition=Ready pod/postgres --timeout=180s || return 1
  # Only the required values (the chart's example), with the image this run built.
  helm --kube-context "$ctx" install ostra deploy/helm/ostra-server -n ostra -f deploy/helm/ostra-server/examples/required-values.yaml --set image.pullPolicy=Never --wait --timeout 6m || {
    kubectl --context "$ctx" -n ostra get pods -o wide
    kubectl --context "$ctx" -n ostra logs -l app.kubernetes.io/name=ostra-server --tail=50 --all-containers
    return 1
  }
  kubectl --context "$ctx" -n ostra get pods -o wide
  kubectl --context "$ctx" -n ostra port-forward svc/ostra-ostra-server-web 13000:3000 >/dev/null 2>&1 &
  forward=$!
  sleep 3
  code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:13000/sign-in)"
  kill "$forward"
  echo "the panel answered $code"
  [ "$code" = "200" ]
}

runner_chart() {
  local ctx="kind-$1" hash made=""
  # The chart's server makes no bootstrap join token (OSTRA_BOOTSTRAP_JOIN_TOKEN=false: each core
  # replica's data folder is its own), so the token is made here the way the pool page's "new join
  # token" makes one: `ostra-join-` and 32 random bytes, stored by its SHA-256 for the default pool
  # of the organization the panel seeded at first start. The token goes from a file into the
  # secret; only its hash is in a command, and neither is in this log.
  (umask 077 && node -e 'process.stdout.write("ostra-join-" + require("node:crypto").randomBytes(32).toString("base64url"))' >"$BIN/join-token") || return 1
  hash="$(sha256sum "$BIN/join-token" | cut -d ' ' -f 1)"
  for _ in $(seq 1 24); do
    made="$(kubectl --context "$ctx" -n ostra exec postgres -- psql -U ostra -d ostra -v ON_ERROR_STOP=1 -qtAc "INSERT INTO join_token (id, \"organizationId\", \"poolId\", \"tokenHash\", label) SELECT gen_random_uuid()::text, \"organizationId\", id, '$hash', 'live-kind' FROM runner_pool WHERE \"isDefault\" ORDER BY \"createdAt\" LIMIT 1 RETURNING id" 2>&1)"
    if echo "$made" | grep -qxE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'; then break; fi
    echo "no default pool yet: ${made:-no row}"
    made=""
    sleep 5
  done
  [ -n "$made" ] || { rm -f "$BIN/join-token"; echo "no join token: the panel seeded no default pool"; return 1; }
  echo "a join token for the default pool: $made"
  kubectl --context "$ctx" -n ostra create secret generic ostra-join-token --from-file=join-token="$BIN/join-token" >/dev/null || return 1
  rm -f "$BIN/join-token"
  helm --kube-context "$ctx" install ostra-runner deploy/helm/ostra-runner -n ostra -f deploy/helm/ostra-runner/examples/required-values.yaml --set image.pullPolicy=Never || return 1
  kubectl --context "$ctx" -n ostra get all
}

runner_joins() {
  local ctx="kind-$1"
  for _ in $(seq 1 36); do
    if kubectl --context "$ctx" -n ostra logs -l app.kubernetes.io/component=core --tail=-1 2>/dev/null | grep -q '"msg":"gateway.peer-open"'; then
      echo "the chart's runner connected"
      return 0
    fi
    sleep 5
  done
  kubectl --context "$ctx" -n ostra logs -l app.kubernetes.io/name=ostra-runner --tail=40
  return 1
}

# The egress baseline on a pod the policy selects (`ostra.dev/role: box`): the node's kubelet, in a
# private range, must be blocked; the server's address (the baseline's one exception) must be
# reached. The control pod, in a namespace with no policy, reaches the same kubelet, which shows
# the address answers: on Calico the probe is blocked and the control connects (enforced); on
# flannel both connect (ignored, told apart). A timeout is inconclusive, never a pass.
egress_probes() {
  local ctx="kind-$1" expect="$2" node_ip server_ip probe box control
  node_ip="$(kubectl --context "$ctx" get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')"
  server_ip="$(kubectl --context "$ctx" -n ostra get svc ostra-ostra-server-core -o jsonpath='{.spec.clusterIP}')"
  probe='for target in "$@"; do if nc -z -w 5 ${target%:*} ${target#*:}; then echo "$target connected"; else echo "$target blocked"; fi; done'
  kubectl --context "$ctx" -n ostra-boxes run egress-probe --image "$BUSYBOX_IMAGE" --labels ostra.dev/role=box --restart Never --command -- sh -c "$probe" probe "$node_ip:10250" "$server_ip:8787" || return 1
  kubectl --context "$ctx" -n default run egress-control --image "$BUSYBOX_IMAGE" --restart Never --command -- sh -c "$probe" probe "$node_ip:10250" || return 1
  kubectl --context "$ctx" -n ostra-boxes wait --for=jsonpath='{.status.phase}'=Succeeded pod/egress-probe --timeout=120s || return 1
  kubectl --context "$ctx" -n default wait --for=jsonpath='{.status.phase}'=Succeeded pod/egress-control --timeout=120s || return 1
  box="$(kubectl --context "$ctx" -n ostra-boxes logs egress-probe)"
  control="$(kubectl --context "$ctx" -n default logs egress-control)"
  echo "box: $box"
  echo "control: $control"
  kubectl --context "$ctx" -n ostra-boxes delete pod egress-probe --wait=false >/dev/null
  kubectl --context "$ctx" -n default delete pod egress-control --wait=false >/dev/null
  echo "$control" | grep -q "$node_ip:10250 connected" || { echo "the control didn't connect: inconclusive"; return 1; }
  echo "$box" | grep -q "$server_ip:8787 connected" || { echo "the server's exception didn't hold"; return 1; }
  case "$expect" in
    enforced) echo "$box" | grep -q "$node_ip:10250 blocked" ;;
    ignored) echo "$box" | grep -q "$node_ip:10250 connected" ;;
  esac
}

# The kubelet pulls a box image by digest with a per-box pull secret, and is refused without one.
kubelet_pull() {
  local ctx="kind-$1" ref reason
  [ -n "$BASE_DIGEST" ] || { echo "no digest from the push"; return 1; }
  kubectl --context "$ctx" -n ostra-boxes create secret docker-registry live-pull --docker-server=localhost:5001 --docker-username="$REGISTRY_USER" --docker-password="$REGISTRY_TOKEN" >/dev/null || return 1
  ref="localhost:5001/ostra/live-base@$BASE_DIGEST"
  kubectl --context "$ctx" -n ostra-boxes run pull-with --image "$ref" --overrides '{"spec":{"imagePullSecrets":[{"name":"live-pull"}]}}' --restart Never --command -- node -e 'console.log("pulled")' || return 1
  kubectl --context "$ctx" -n ostra-boxes run pull-without --image "$ref" --image-pull-policy Always --restart Never --command -- node -e 'console.log("pulled")' || return 1
  kubectl --context "$ctx" -n ostra-boxes wait --for=jsonpath='{.status.phase}'=Succeeded pod/pull-with --timeout=180s || return 1
  sleep 20
  reason="$(kubectl --context "$ctx" -n ostra-boxes get pod pull-without -o jsonpath='{.status.containerStatuses[0].state.waiting.reason}')"
  echo "with the secret: $(kubectl --context "$ctx" -n ostra-boxes logs pull-with); without: $reason"
  kubectl --context "$ctx" -n ostra-boxes delete pod pull-with pull-without secret/live-pull --wait=false >/dev/null 2>&1
  kubectl --context "$ctx" -n ostra-boxes delete secret live-pull >/dev/null 2>&1
  case "$reason" in ErrImagePull | ImagePullBackOff) return 0 ;; *) return 1 ;; esac
}

# A node with no room: the pod is unschedulable and the scheduler says so, which is what the
# executor reads as waiting (it isn't an autoscaler: that stays ticket 38's).
unschedulable() {
  local ctx="kind-$1" node phase scheduled
  node="$(kubectl --context "$ctx" get nodes -o name | head -n 1)"
  kubectl --context "$ctx" cordon "$node" || return 1
  kubectl --context "$ctx" -n ostra-boxes run waiting --image "$BUSYBOX_IMAGE" --restart Never --command -- true || return 1
  sleep 15
  kubectl --context "$ctx" -n ostra-boxes get events --field-selector involvedObject.name=waiting
  phase="$(kubectl --context "$ctx" -n ostra-boxes get pod waiting -o jsonpath='{.status.phase}')"
  scheduled="$(kubectl --context "$ctx" -n ostra-boxes get pod waiting -o jsonpath='{.status.conditions[?(@.type=="PodScheduled")].reason}')"
  kubectl --context "$ctx" uncordon "$node" >/dev/null
  kubectl --context "$ctx" -n ostra-boxes delete pod waiting --wait=false >/dev/null
  echo "phase $phase, PodScheduled $scheduled"
  [ "$phase" = "Pending" ] && [ "$scheduled" = "Unschedulable" ]
}

released_clean() {
  local ctx="kind-$1" left
  helm --kube-context "$ctx" uninstall ostra-runner -n ostra --wait || return 1
  left="$(kubectl --context "$ctx" -n ostra-boxes get all,secrets,networkpolicies --no-headers 2>/dev/null | grep -v '^secret/default-token' || true)"
  echo "left in ostra-boxes: ${left:-nothing}"
  [ -z "$left" ]
}

# on_cluster <cluster> <check> <function> [args...]: the step `<cluster>-<check>`, which runs
# `<function> <cluster> [args...]` against the context kind-<cluster>. Each step is handed the
# cluster's own name, never an earlier step's; when the cluster's step failed, there's no context
# to run against, and the step is skipped.
on_cluster() {
  local cluster="$1" check="$2" fn="$3"
  shift 3
  if passed "$cluster-cluster"; then
    step "$cluster-$check" "$fn" "$cluster" "$@"
  else
    skipped "$cluster-$check" "cluster failed, see $cluster-cluster.log"
  fi
}

for cluster in "${CLUSTERS[@]}"; do
  read -r name kind_version _ image cni <<<"$cluster"
  expect="enforced"
  [ "$cni" = "calico" ] || expect="ignored"
  step "$name-cluster" make_cluster "$name" "$kind_version" "$image" "$cni"
  on_cluster "$name" server-chart server_chart
  on_cluster "$name" runner-chart runner_chart
  on_cluster "$name" runner-joins runner_joins
  on_cluster "$name" "egress-$expect" egress_probes "$expect"
  on_cluster "$name" kubelet-pull kubelet_pull
  on_cluster "$name" unschedulable unschedulable
  not_run "$name-box-as-a-pod" "a box as a pod with its services, ready in under 60 s, needs a task dispatched end to end on the cluster (a stub model and a git upstream the pod reaches), which this job doesn't set up yet"
  not_run "$name-buildkit" "the rootless BuildKit pod's build, scan and push needs a snapshot build requested through core on the cluster, which this job doesn't drive yet"
  on_cluster "$name" released-clean released_clean
  if passed "$name-cluster"; then
    kubectl --context "kind-$name" -n ostra logs -l app.kubernetes.io/name=ostra-server --tail=-1 --all-containers >"$LIVE_OUT/$name-server-pods.log" 2>&1
  fi
  "kind-$kind_version" delete cluster --name "$name" >/dev/null 2>&1
done

finish
