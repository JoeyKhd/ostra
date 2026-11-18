# gVisor runtime config

ADR 0031: the docs recommend gVisor as the box runtime, and spike 3 runs every
check with it too. These two files configure it.

## Docker (`daemon.json`)

Install `runsc` (the gVisor runtime), then merge `daemon.json` into
`/etc/docker/daemon.json` and restart Docker:

```
sudo cp daemon.json /etc/docker/daemon.json   # or merge "runtimes" into yours
sudo systemctl restart docker
docker info | grep -i runtimes                 # runsc should appear
```

Then start the box with `OSTRA_AGENT_RUNTIME=runsc` (the `agent` service in
`../docker/compose.box.yaml` reads it; the default is `runc`), or run
`pnpm spike --real=docker --runtime=runsc`. The `runsc` runtime uses the `systrap` platform,
which needs no nested virtualization, so it runs on an ordinary cloud VM. On a
host with KVM, the `runsc-kvm` runtime (or Kata) can be selected instead with
no change to ostra's code (`research/elastic-sandboxes.md`).

Rootless Docker with gVisor is fragile (ADR 0031, gVisor issue #12575); the
spike records that as a known limitation.

## Kubernetes (`runtimeclass.yaml`)

The node must have the `runsc` containerd shim installed and a runtime handler
named `runsc`. Apply the RuntimeClass, then a box pod selects it with
`OSTRA_RUNTIME_CLASS=gvisor` (`box-pod.yaml` templates `runtimeClassName`; an
empty value drops the line and runs on the node's default runtime):

```
kubectl apply -f runtimeclass.yaml
pnpm spike --real=k8s --runtime-class=gvisor
```

`runtimeclass.yaml` has no `scheduling:` block, so it works on any cluster
whose nodes have the handler (k3s, kind, plain containerd). On GKE, enable GKE
Sandbox on a node pool and apply `runtimeclass.gke.yaml` instead: it selects and
tolerates the `sandbox.gke.io/runtime=gvisor` label and taint GKE sets.
