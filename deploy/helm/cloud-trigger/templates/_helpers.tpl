{{- define "ct.fullname" -}}{{ printf "%s" .Release.Name | trunc 63 | trimSuffix "-" }}{{- end -}}
{{- define "ct.labels" -}}
app.kubernetes.io/name: cloud-trigger
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{- define "ct.image" -}}{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}{{- end -}}
{{- define "ct.secretName" -}}{{ .Values.secrets.existingSecret | default (printf "%s-env" (include "ct.fullname" .)) }}{{- end -}}

{{/* Deployment for one role set. Args: dict "root" $ "name" "api" "roles" "api" "spec" <role values> */}}
{{- define "ct.deployment" -}}
{{- $root := .root -}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "ct.fullname" $root }}-{{ .name }}
  labels: {{- include "ct.labels" $root | nindent 4 }}
    app.kubernetes.io/component: {{ .name }}
spec:
  {{- if not (and .spec.autoscaling .spec.autoscaling.enabled) }}
  replicas: {{ .spec.replicas }}
  {{- end }}
  selector:
    matchLabels:
      app.kubernetes.io/instance: {{ $root.Release.Name }}
      app.kubernetes.io/component: {{ .name }}
  template:
    metadata:
      labels: {{- include "ct.labels" $root | nindent 8 }}
        app.kubernetes.io/component: {{ .name }}
      annotations:
        checksum/config: {{ toJson $root.Values.config | sha256sum }}
    spec:
      {{- with $root.Values.imagePullSecrets }}
      imagePullSecrets: {{- toYaml . | nindent 8 }}
      {{- end }}
      securityContext: {{- toYaml $root.Values.podSecurityContext | nindent 8 }}
      # Workers finish in-flight runs on SIGTERM; give them the lease window.
      terminationGracePeriodSeconds: 60
      containers:
        - name: app
          image: {{ include "ct.image" $root }}
          imagePullPolicy: {{ $root.Values.image.pullPolicy }}
          securityContext: {{- toYaml $root.Values.securityContext | nindent 12 }}
          env:
            - name: APP_ROLE
              value: {{ .roles | quote }}
            - name: INSTANCE_ID
              valueFrom: { fieldRef: { fieldPath: metadata.name } }
            {{- if $root.Values.jobSecrets.existingSecret }}
            - name: SECRETS_DIR
              value: /var/run/secrets/cloud-trigger
            {{- end }}
          envFrom:
            - configMapRef: { name: {{ include "ct.fullname" $root }}-config }
            - secretRef: { name: {{ include "ct.secretName" $root }} }
          ports:
            - { name: http, containerPort: 8080 }
          readinessProbe:
            httpGet: { path: /health/ready, port: http }
            periodSeconds: 10
          livenessProbe:
            httpGet: { path: /health/live, port: http }
            periodSeconds: 20
          resources: {{- toYaml .spec.resources | nindent 12 }}
          volumeMounts:
            - { name: tmp, mountPath: /tmp }
            {{- if $root.Values.jobSecrets.existingSecret }}
            - { name: job-secrets, mountPath: /var/run/secrets/cloud-trigger, readOnly: true }
            {{- end }}
      volumes:
        - name: tmp
          emptyDir: {}
        {{- if $root.Values.jobSecrets.existingSecret }}
        - name: job-secrets
          secret: { secretName: {{ $root.Values.jobSecrets.existingSecret }} }
        {{- end }}
      {{- with $root.Values.nodeSelector }}
      nodeSelector: {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $root.Values.tolerations }}
      tolerations: {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $root.Values.affinity }}
      affinity: {{- toYaml . | nindent 8 }}
      {{- end }}
{{- end -}}
