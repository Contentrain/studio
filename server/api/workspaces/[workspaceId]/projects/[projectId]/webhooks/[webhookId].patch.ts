import { runEnterpriseRoute } from '../../../../../../utils/enterprise'

export default defineEventHandler(event => runEnterpriseRoute('updateProjectWebhook', 'webhook.upgrade', event))
