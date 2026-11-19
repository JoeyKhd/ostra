{{- define "ostra-runner.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "ostra-runner.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "ostra-runner.labels" -}}
{{ include "ostra-runner.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: ostra
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* An address as a CIDR of one host; a CIDR as it is (egress.ts's asCidr). */}}
{{- define "ostra-runner.cidr" -}}
{{- if contains "/" . -}}
{{ . }}
{{- else if contains ":" . -}}
{{ . }}/128
{{- else -}}
{{ . }}/32
{{- end -}}
{{- end -}}

{{/* DNS at the cluster's resolver, in kube-system, only. */}}
{{- define "ostra-runner.dnsRule" -}}
- to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
  ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53
{{- end -}}
