import { runEnterpriseRoute } from '../../../../../../utils/enterprise'

export default defineEventHandler(event => runEnterpriseRoute('createProjectWebhook', 'webhook.upgrade', event, 'api.webhooks_outbound'))
