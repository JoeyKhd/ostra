{{/* The release's name for its objects: "<release>-ostra-server", or the release's own name when it says ostra-server already. */}}
{{- define "ostra-server.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "ostra-server.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "ostra-server.labels" -}}
{{ include "ostra-server.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: ostra
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "ostra-server.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}

{{/* The one secret every server process reads its three keys from. */}}
{{- define "ostra-server.keysSecret" -}}
{{- .Values.secrets.existingSecret | default (printf "%s-keys" (include "ostra-server.fullname" .)) -}}
{{- end -}}

{{- define "ostra-server.databaseSecret" -}}
{{- if .Values.database.url -}}
{{- printf "%s-database" (include "ostra-server.fullname" .) -}}
{{- else -}}
{{- required "database.url or database.existingSecret is required" .Values.database.existingSecret -}}
{{- end -}}
{{- end -}}

{{/* The environment of every server process: the same database, the same three keys. */}}
{{- define "ostra-server.env" -}}
{{- range $name, $value := .Values.env }}
- name: {{ $name }}
  value: {{ $value | quote }}
{{- end }}
- name: NODE_ENV
  value: production
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "ostra-server.databaseSecret" . }}
      key: {{ .Values.database.existingSecretKey }}
{{- range list "OSTRA_SECRETS_KEY" "BETTER_AUTH_SECRET" "OSTRA_RUNNER_TOKEN_KEY" }}
- name: {{ . }}
  valueFrom:
    secretKeyRef:
      name: {{ include "ostra-server.keysSecret" $ }}
      key: {{ . }}
{{- end }}
- name: OSTRA_WEB_PORT
  value: {{ .Values.web.port | quote }}
- name: OSTRA_CORE_PORT
  value: {{ .Values.core.port | quote }}
- name: OSTRA_CORE_INTERNAL_URL
  value: {{ printf "http://%s-core:%v" (include "ostra-server.fullname" .) .Values.core.port | quote }}
- name: OSTRA_DATA_DIR
  value: /var/lib/ostra
{{- with .Values.publicUrl }}
- name: OSTRA_PUBLIC_URL
  value: {{ . | quote }}
{{- end }}
{{- with .Values.corePublicUrl }}
- name: OSTRA_CORE_PUBLIC_URL
  value: {{ . | quote }}
{{- end }}
{{- end -}}

{{- define "ostra-server.podSecurity" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
fsGroup: 1000
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "ostra-server.containerSecurity" -}}
allowPrivilegeEscalation: false
capabilities:
  drop: ["ALL"]
{{- end -}}
