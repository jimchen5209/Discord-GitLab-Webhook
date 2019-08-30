/*
 * HTTP request handling based on
 * https://blog.kyletolle.com/using-node-js-to-inspect-webhook-calls/
 * Test it in a second client with cURL
 * curl -X POST localhost:9000 -H 'Content-Type: text/plain' -d '{'payload':'test'}'
 * cat sample/unrelated.json | curl -i -v -X POST localhost:9000 -H 'Content-Type: text/plain' -H 'X-Gitlab-Token: TOKEN' -H 'X-Gitlab-Event: EVENT' --data-binary '@-'
 */

// Import FS for reading sample files
const FS = require('fs');
// Import the CRYPTO module for verifying tokens from HTTP request headers
const CRYPTO = require('crypto');
// Import the HTTP module for sending and receiving data
const HTTP = require('http');
// Import the discord.js module
const DISCORD = require('discord.js');
// Import DEDENT for nice template literal strings
const DEDENT = require('dedent-js');

// Import CONFIG file
const CONFIG = require('./require/config.json');
const SECRET = CONFIG.webhook.token || process.env.DGW_WEBHOOK_TOKEN || '';
const BOT_SECRET = CONFIG.bot.token || process.env.DGW_BOT_TOKEN || '';

/* ============================================
 * Set up states and timers
 * ========================================= */
var storedData = [];
var userTimerEnabled = false;
var disconnectHandled = false;
var readyMsg = 'ready';
var IS_DEBUG_MODE = false;

/* ============================================
 * Set up Webhook stuff
 * ========================================= */

// Create an instance of a Discord client
const CLIENT = new DISCORD.Client();

const HOOK = new DISCORD.WebhookClient(CONFIG.webhook.id, CONFIG.webhook.token);

/* ============================================
 * Timer to check if disconnected from Discord
 * ========================================= */

var checkDisconnect = function() {
  //console.log('### Routine check client.status: ' + CLIENT.status + '; uptime: ' + CLIENT.uptime);
  // if connection is lost, 
  if (!userTimerEnabled && !disconnectHandled && CLIENT != null && CLIENT.status == 5) {
    // set disconnectHandled
    disconnectHandled = true;
    // set ready message to 'Recovering from unexpected shutdown'
    readyMsg = 'rebooted';
    // try to login again (when ready, set interval again) 
    CLIENT.login(CONFIG.bot.token);
  }
};

// Set a timeout for 120000 or 2 minutes  OR 3000 for 3sec
var interval_dc = setInterval(checkDisconnect, 3000);


/* ============================================
 * Set up Server listening stuff
 * ========================================= */

// Create our local webhook-receiving server
var app = HTTP.createServer(handler);

// Handler for receiving HTTP requests
function handler(req, res) {

  // Assume it's all good at first...
  var statusCode = 200;

  // Keep track of incoming data
  let data = '';
  let type = req.headers['content-type'];
  let passChecked = null;

  // Correctly format Response according to https://nodejs.org/en/docs/guides/anatomy-of-an-http-transaction/
  let headers = req.headers;
  let method = req.method;
  let url = req.url;
  let body = '';

  // Only do stuff if the request came via POST
  if (req.method == 'POST') {

    console.log('---- Post Request Detected ----');

    // Data collection handler
    req.on('data', function(chunk) {

      console.log('reading...');
      //data += chunk;


      if (passChecked === false) { // this data is already determined to be invalid
        console.log('Data was invalid, skipping...');
        return;

      } else if (passChecked != null) {
        data += chunk;
        return;

      } else {

        //console.log(req.headers);

        // Is the first chunk, check the headers for validity
        if (req.headers.hasOwnProperty('x-gitlab-token')) {

          // Compare tokens
          let a = Buffer.from(req.headers['x-gitlab-token']);
          let b = Buffer.from(SECRET);
          let isValid = (SECRET != '') && (a.length - b.length) == 0 && CRYPTO.timingSafeEqual(a, b);

          if (!isValid) {
            // otherwise, do nothing
            console.log('Invalid');
            passChecked = false;

            // send a Bad Request response
            statusCode = 400;
            res.writeHead(statusCode, { 'Content-Type': 'application/json' });
            let responseBody = {
              headers: headers,
              method: method,
              url: url,
              body: body
            };
            res.write(JSON.stringify(responseBody));
            res.end();

            // stop receiving request data
            req.destroy(new MyError('Invalid token'));
            console.log('==== DESTROYED ====');
            return;

          } else {
            // do something
            passChecked = true;
            statusCode = 200;

            // get the event type
            type = req.headers['x-gitlab-event'];
            console.log('event type is: ', type);

            // increment data
            data += chunk;
          }

        } else { // No Gitlab header detected
          // otherwise, do nothing
          console.log('Not from GitLab');
          passChecked = false;

          // send a Bad Request response
          statusCode = 400;
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          let responseBody = {
            headers: headers,
            method: method,
            url: url,
            body: body
          };
          res.write(JSON.stringify(responseBody));
          res.end();

          // stop receiving request data
          req.destroy(new MyError('Not from GitLab'));
          console.log('==== DESTROYED ====');
          return;
        }
      }

    });

    // Completion handler
    req.on('end', function() {
      console.log('finishing up...');

      if (passChecked) {
        // Let the sender know we received things alright
        res.setHeader('Content-Type', 'application/json');
        let responseBody = {
          headers: headers,
          method: method,
          url: url,
          body: body
        };
        res.end(JSON.stringify(responseBody));

        // Process Data
        try {
          //console.log(data);
          // Log the data for debugging
          debugData(data);

          // To accept everything as a string
          //data = JSON.parse(JSON.stringify(data));

          // To read JSON as JSON and everything else as a string
          //data = (headers['content-type'] == 'application/json') ? JSON.parse(data) : ''+data;

          // Assume only JSON formatting, and let all else be caught as an error and read as a string
          data = JSON.parse(data);

          processData(type, data);

        } catch (e) {
          console.log('Error Context: Data is not formatted as JSON');
          console.error(e);
          processData('Known Error', { message: 'Expected JSON, but received a possibly mislabeled ' + headers['content-type'], body: JSON.stringify(data) });
        }
      }
      console.log('==== DONE ====');
    });

    // Error Handler
    req.on('error', function(e) {
      console.log('Error Context: handling an HTTP request');
      console.error(e);
    });

  }

  // TODO: handle other HTTP request types

}

// Debug Mode helper
function debugData(data) {
  if (IS_DEBUG_MODE) {
    let channel = CLIENT.channels.get(CONFIG.bot.debug_channel_id);
    channel.send(data, { code: 'json', split: { maxLength: 1500, char: ',' } })
      .catch(console.error);
  }
}

// Colors corresponding to different events
const ColorCodes = {
  issue_opened: 15426592, // orange
  issue_closed: 5198940, // grey
  issue_comment: 15109472, // pale orange
  commit: 7506394, // blue
  release: 2530048, // green
  merge_request_opened: 12856621, // red
  merge_request_closed: 2530048, // green
  merge_request_comment: 15749300, // pink
  default: 5198940, // grey
  error: 16773120, // yellow
  red: 12856621,
  green: 2530048,
  grey: 5198940
};

const StrLen = {
  title: 128,
  description: 128,
  field_name: 128,
  field_value: 128,
  commit_id: 8,
  commit_msg: 32,
  json: 256,
  snippet_code: 256
};

/**
 * Helper method for ensuring data string is of a certain length or less and not null
 */
function truncate(str, count, noElipses, noNewLines) {
  if (noNewLines) str = str.split('\n').join(' ');
  if (!count && str) return str;
  if (count && str && noElipses) {
    return str.substring(0, count);
  } else if (str && str.length > 0) {
    if (str.length <= count) return str;
    return str.substring(0, count - 3) + '...';
  } else {
    return "";
  }
}

// Assumes str is a gravatar url or a relative url to an avatar image upload
// NOTE: this may not be needed in the latest GitLab instances
function getAvatarURL(str) {
  if (str == null) return "";
  if (str.startsWith('/')) return CONFIG.webhook.gitlab_url + str;
  return str;
}


/* 
 * A function for processing data received from an HTTP request
 * 
 */
function processData(type, data) {
  console.log('processing...');

  dateOptions = { //https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/toLocaleString
    hour12: true,
    weekday: "short",
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "numeric",
    timeZoneName: "short"
  };

  let output = {
    COLOR: ColorCodes.default,
    TITLE: '',
    USERNAME: '',
    AVATAR_URL: '',
    PERMALINK: '',
    DESCRIPTION: '',
    FIELDS: [],
    TIME: new Date(),
    FOOTER: {
      icon_url: CONFIG.webhook.icon_url,
      text: CONFIG.webhook.name
    }
  };

  // Set up common values, if they exist
  if (data.user) {
    output.USERNAME = truncate(data.user.username) || truncate(data.user.name);
    output.AVATAR_URL = getAvatarURL(data.user.avatar_url);
  } else {
    output.USERNAME = truncate(data.user_username) || truncate(data.user_name);
    output.AVATAR_URL = getAvatarURL(data.user_avatar);
  }
  if (data.project) {
    output.PERMALINK = truncate(data.project.web_url);
    output.TITLE = `[${data.project.path_with_namespace}] ${type}`;
  }

  let skipped = false;
  try {
    switch (type) {

      case 'Push Hook':
        output.COLOR = ColorCodes.commit;

        if (data.commits.length < 1) {
          debugData(JSON.stringify(data));
        } else if (data.commits.length == 1) {
          output.DESCRIPTION = DEDENT `
          **1 New Commit**\n
          ${data.commits[0].message}\n
          ${data.commits[0].modified.length} change(s)\n
          ${data.commits[0].added.length} addition(s)\n
          ${data.commits[0].removed.length} deletion(s)
          `;
        } else {
          output.DESCRIPTION = `**${data.total_commits_count} New Commits**\n`;
          for (let i = 0; i < Math.min(data.commits.length, 5); i++) {
            let changelog = DEDENT `
            ${data.commits[i].modified.length} change(s)
            ${data.commits[i].added.length} addition(s)
            ${data.commits[i].removed.length} deletion(s)
            `;
            output.DESCRIPTION += `[${truncate(data.commits[i].id,StrLen.commit_id,true)}](${data.commits[i].url} '${changelog}') ${truncate(data.commits[i].message,StrLen.commit_msg)} - ${data.commits[i].author.name}\n`;
          }
        }
        break;

      case 'Tag Push Hook':
        output.DESCRIPTION = `**Tag ${data.ref.substring('refs/tags/'.length)}**\n`;
        output.PERMALINK = `${data.project.web_url}/${data.ref}`;

        // Commit Stuff
        if (data.commits.length < 1) {
          debugData(JSON.stringify(data));
        } else if (data.commits.length == 1) {
          output.DESCRIPTION += DEDENT `
          ${data.commits[0].message}\n
          ${data.commits[0].modified.length} change(s)\n
          ${data.commits[0].added.length} addition(s)\n
          ${data.commits[0].removed.length} deletion(s)
          `;
        } else {
          for (let i = 0; i < Math.min(data.commits.length, 5); i++) {
            let changelog = DEDENT `
            ${data.commits[i].modified.length} change(s)
            ${data.commits[i].added.length} addition(s)
            ${data.commits[i].removed.length} deletion(s)
            `;
            output.DESCRIPTION += `[${truncate(data.commits[i].id,StrLen.commit_id,true)}](${data.commits[i].url} '${changelog}') ${truncate(data.commits[i].message,StrLen.commit_msg)} - ${data.commits[i].author.name}\n`;
          }
        }
        // Tag Stuff
        output.FIELDS.push({
          inline: true,
          name: 'Previous',
          value: `[${truncate(data.before, StrLen.commit_id, true)}](${data.project.web_url}/commit/${data.before} 'Check the previous tagged commit')`
        });
        output.FIELDS.push({
          inline: true,
          name: 'Current',
          value: `[${truncate(data.after, StrLen.commit_id, true)}](${data.project.web_url}/commit/${data.after} 'Check the current tagged commit')`
        });

        break;

	  case 'Issue Hook':
	  case 'Confidential Issue Hook':
		output.PERMALINK = truncate(data.object_attributes.url);
		let action = 'Issue';

		switch (data.object_attributes.action) {
			case 'open':
				output.COLOR = ColorCodes.issue_opened;
				action = 'Issue Opened:';
				break;
			case 'close':
				output.COLOR = ColorCodes.issue_closed;
				action = 'Issue Closed:';
				break;
			default:
				output.COLOR = ColorCodes.issue_comment;
				console.log('## Unhandled case for Issue Hook ', data.object_attributes.action);
				break;
		}

		if (data.object_attributes.confidential) { // TODO support multiple hooks for private and public updates
			output.DESCRIPTION += `**${action} [CONFIDENTIAL]**\n`;
		} else {
			output.DESCRIPTION += `**${action} #${data.object_attributes.iid} ${data.object_attributes.title}**\n`;
			output.DESCRIPTION += truncate(data.object_attributes.description, StrLen.description);

			if (data.assignees && data.assignees.length > 0) {
			let assignees = { inline: true, name: 'Assigned To:', value: '' };
			for (let i = 0; i < data.assignees.length; i++) {
				assignees.value += `${data.assignees[i].username}\n`;
			}
			output.FIELDS.push(assignees);
			}

			if (data.labels && data.labels.length > 0) {
			let labels = { inline: true, name: 'Labeled As:', value: '' };
			for (let i = 0; i < data.labels.length; i++) {
				labels.value += `${data.labels[i].title}\n`;
			}
			output.FIELDS.push(labels);
			}
		}
        break;

      case 'Note Hook':
        output.PERMALINK = data.object_attributes.url;

        output.FIELDS.push({
          name: 'Comment',
          value: truncate(data.object_attributes.note, StrLen.field_value)
        });

        switch (data.object_attributes.noteable_type) {

          case 'commit':
          case 'Commit':
            output.COLOR = ColorCodes.commit;
            output.DESCRIPTION = `**New Comment on Commit ${truncate(data.commit.id,StrLen.commit_id,true)}**\n`;

            let commit_info = `[${truncate(data.commit.id,StrLen.commit_id,true)}](${data.commit.url}) `;
            commit_info += `${truncate(data.commit.message,StrLen.commit_msg, false, true)} - ${data.commit.author.name}`;
            output.FIELDS.push({
              name: 'Commit',
              value: commit_info
            });

            let commit_date = new Date(data.commit.timestamp);
            output.FIELDS.push({
              name: 'Commit Timestamp',
              // Given Format: 2014-02-27T10:06:20+02:00
              value: commit_date.toLocaleString('UTC', dateOptions)
            });
            break;

          case 'merge_request':
          case 'MergeRequest':
            output.COLOR = ColorCodes.merge_request_comment;

            let mr_state = (data.merge_request.state) ? `[${data.merge_request.state}]` : '';
            output.DESCRIPTION = DEDENT `
              **New Comment on Merge Request #${data.merge_request.iid}**
              *Merge Status: ${data.merge_request.merge_status}* ${mr_state}
              ${data.merge_request.title}`;

            let last_commit_info = `[${truncate(data.merge_request.last_commit.id,StrLen.commit_id,true)}](${data.merge_request.last_commit.url}) `;
            last_commit_info += `${truncate(data.merge_request.last_commit.message,StrLen.commit_msg, false, true)} - ${data.merge_request.last_commit.author.name}`;
            output.FIELDS.push({
              name: 'Latest Commit',
              value: last_commit_info
            });

            output.FIELDS.push({
              name: 'Assigned To',
              value: truncate(data.merge_request.assignee.username)
            });

            let mr_date = new Date(data.merge_request.created_at);
            output.FIELDS.push({
              name: 'Merge Request Timestamp',
              // Given Format: 2014-02-27T10:06:20+02:00
              value: mr_date.toLocaleString('UTC', dateOptions)
            });

            break;

          case 'issue':
          case 'Issue':
            output.COLOR = ColorCodes.issue_comment;

            let issue_state = (data.issue.state) ? ` [${data.issue.state}]` : '';
            output.DESCRIPTION = `**New Comment on Issue #${data.issue.iid} ${data.issue.title} ${issue_state}**\n`;

            let issue_date = new Date(data.issue.created_at);
            output.FIELDS.push({
              name: 'Issue Timestamp',
              // Given Format: 2014-02-27T10:06:20+02:00
              value: issue_date.toLocaleString('UTC', dateOptions)
            });

            break;

          case 'snippet':
          case 'Snippet':
            output.DESCRIPTION = `**New Comment on Code Snippet**\n`;

            output.FIELDS.push({
              inline: true,
              name: 'Title',
              value: truncate(data.snippet.title, StrLen.field_value)
            });

            output.FIELDS.push({
              inline: true,
              name: 'File Name',
              value: truncate(data.snippet.file_name, StrLen.field_value)
            });

            let snip_filetype = data.snippet.file_name.substr(data.snippet.file_name.lastIndexOf('.') + 1);
            output.FIELDS.push({
              name: 'Code Snippet',
              value: '```' + snip_filetype + '\n' + truncate(data.snippet.content, StrLen.snippet_code) + '\n```'
            });

            let snip_date = new Date(data.snippet.created_at);
            output.FIELDS.push({
              name: 'Snippet Timestamp',
              // Given Format: 2014-02-27T10:06:20+02:00
              value: snip_date.toLocaleString('UTC', dateOptions)
            });
            break;

          default:
            console.log('## Unhandled case for Note Hook ', data.object_attributes.noteable_type);
            break;
        }

        break;

      case 'Merge Request Hook':
        output.PERMALINK = data.object_attributes.url;
        output.TITLE = `[${data.object_attributes.target.path_with_namespace}] Merge Request Hook`;

        switch (data.object_attributes.action) {
          case 'open':
            output.COLOR = ColorCodes.merge_request_opened;
            output.DESCRIPTION = `**Merge Request Opened: #${data.object_attributes.iid} ${data.object_attributes.title}**\n`;
            break;
          case 'close':
            output.COLOR = ColorCodes.merge_request_closed;
            output.DESCRIPTION = `**Merge Request Closed: #${data.object_attributes.iid} ${data.object_attributes.title}**\n`;
            break;
          default:
            output.COLOR = ColorCodes.merge_request_comment;
            console.log('## Unhandled case for Merge Request Hook ', data.object_attributes.action);
            break;
        }

        output.DESCRIPTION += DEDENT `
          *Merge Status: ${data.object_attributes.merge_status}* [${data.object_attributes.state}]
          ${truncate(data.object_attributes.description, StrLen.description)}
          `;

        output.FIELDS.push({
          inline: true,
          name: 'Merge From',
          value: DEDENT `
            ${data.object_attributes.source.namespace}/
            ${data.object_attributes.source.name}:
            [${data.object_attributes.source_branch}](${data.object_attributes.source.web_url})`
        });

        output.FIELDS.push({
          inline: true,
          name: 'Merge Into',
          value: DEDENT `
            ${data.object_attributes.target.namespace}/
            ${data.object_attributes.target.namespace}:
            [${data.object_attributes.target_branch}](${data.object_attributes.target.web_url})`
        });

        /*if (data.object_attributes.source) {
          output.FIELDS.push({
            name: 'Source:',
            value: `[${data.object_attributes.source.path_with_namespace}: ${data.object_attributes.source_branch}](${data.object_attributes.source.web_url} '${data.object_attributes.source.name}')`
          });
        } 

        if (data.object_attributes.target) {
          output.FIELDS.push({
            name: 'Target:',
            value: `[${data.object_attributes.target.path_with_namespace}: ${data.object_attributes.target_branch}](${data.object_attributes.target.web_url} '${data.object_attributes.target.name}')`
          });
        }*/

        if (data.object_attributes.assignee) {
          output.FIELDS.push({
            inline: true,
            name: 'Assigned To',
            value: `${data.object_attributes.assignee.username}`
          });
        }

        if (data.assignees && data.assignees.length > 0) {
          let assignees = { inline: true, name: 'Assigned To:', value: '' };
          for (let i = 0; i < data.assignees.length; i++) {
            assignees.value += `${data.assignees[i].username}\n`;
          }
          output.FIELDS.push(assignees);
        }

        if (data.labels && data.labels.length > 0) {
          let labels = { inline: true, name: 'Labeled As:', value: '' };
          for (let i = 0; i < data.labels.length; i++) {
            labels.value += `${data.labels[i].title}\n`;
          }
          output.FIELDS.push(labels);
        }
        break;

      case 'Wiki Page Hook':
        output.PERMALINK = data.object_attributes.url;
        output.DESCRIPTION = `**Wiki Action: ${data.object_attributes.action}**\n`;
        output.DESCRIPTION += truncate(data.object_attributes.message, StrLen.description);

        output.FIELDS.push({
          name: 'Page Title',
          value: data.object_attributes.title
        });

        if (data.object_attributes.content) {
          output.FIELDS.push({
            name: 'Page Content',
            value: truncate(data.object_attributes.content, 128)
          });
        }
        break;

      case 'Pipeline Hook':
        if (data.object_attributes.status != "success" && data.object_attributes.status != "failed") {
          skipped = true
          console.log('Skipping ${data.object_attributes.status} for not success and failed status');
          break;
        };
        output.DESCRIPTION = `**Pipeline Status Change** [${data.object_attributes.status}]\n`;

        let status_emote = '';

        switch (data.object_attributes.status) {
          case 'failed':
            output.COLOR = ColorCodes.red;
            status_emote = '❌ ';
            break;
          case 'created':
          case 'success':
            output.COLOR = ColorCodes.green;
            status_emote = '✅ ';
            break;
          default:
            output.COLOR = ColorCodes.grey;
            break;
        }

        output.FIELDS.push({
          name: 'Duration',
          value: msToTime(truncate(data.object_attributes.duration * 1000))
        });

        let commit_info = `[${truncate(data.commit.id,StrLen.commit_id,true)}](${data.commit.url}) `;
        commit_info += `${truncate(data.commit.message,StrLen.commit_msg, false, true)} - ${data.commit.author.name}`;
        output.FIELDS.push({
          name: 'Commit',
          value: commit_info
        });

        if (data.builds && data.builds.length > 0) {
          for (let i = 0; i < data.builds.length; i++) {
            let dates = {
              create: new Date(data.builds[i].created_at),
              start: new Date(data.builds[i].started_at),
              finish: new Date(data.builds[i].finished_at)
            };
            let emote = '';
            if (data.builds[i].status == 'failed') emote = '❌';
            if (data.builds[i].status == 'skipped') emote = '↪️';
            if (data.builds[i].status == 'success' || data.builds[i].status == 'created') emote = '✅';

            let build_link = `[${data.builds[i].id}](${data.project.web_url + '/-/jobs/' + data.builds[i].id})`;

            let build_details = `*Skipped Build ID ${build_link}*`;

            if (data.builds[i].status != 'skipped') {
              build_details = DEDENT `
              - **Build ID**: ${build_link}
              - **User**: [${data.builds[i].user.username}](${CONFIG.webhook.gitlab_url}/${data.builds[i].user.username})
              - **Created**: ${dates.create.toLocaleString('UTC',dateOptions)}
              - **Started**: ${dates.start.toLocaleString('UTC',dateOptions)}
              - **Finished**: ${dates.finish.toLocaleString('UTC',dateOptions)}`;
            }
            output.FIELDS.push({
              //inline: true,
              name: `${emote} ${truncate(data.builds[i].stage)}: ${truncate(data.builds[i].name)}`,
              value: build_details
            });
          }
        }
        break;

      case 'Build Hook':
      case 'Job Hook':
        // For some reason GitLab doesn't send user data to job hooks, so set username/avatar to empty
        output.USERNAME = '';
        output.AVATAR_URL = '';
        // It also doesn't include the project web_url ??? or the path with namespace ???
        let canon_url = data.repository.git_http_url.slice(0, -'.git'.length);
        let namespace = canon_url.substr(CONFIG.webhook.gitlab_url.length + 1);

        output.TITLE = `[${namespace}] ${type}`;
        output.DESCRIPTION = `**Job: ${data.build_name}**\n`;
        output.PERMALINK = `${canon_url}/-/jobs/${data.build_id}`;

        output.FIELDS.push({
          name: 'Duration',
          value: msToTime(truncate(data.build_duration * 1000))
        });

        let build_commit_info = `[${truncate(data.commit.sha,StrLen.commit_id,true)}](${canon_url}/commit/${data.commit.sha}) `;
        build_commit_info += `${truncate(data.commit.message,StrLen.commit_msg, false, true)} - ${data.commit.author_name}`;
        output.FIELDS.push({
          name: 'Commit',
          value: build_commit_info
        });

        let build_dates = {
          start: new Date(data.build_started_at),
          finish: new Date(data.build_finished_at)
        };

        let build_emote = '';
        switch (data.build_status) {
          case 'failed':
            output.COLOR = ColorCodes.red;
            build_emote = '❌';
            break;
          case 'created':
          case 'success':
            output.COLOR = ColorCodes.green;
            build_emote = '✅';
            break;
          case 'skipped':
            output.COLOR = ColorCodes.grey;
            build_emote = '↪️';
            break;
          default:
            output.COLOR = ColorCodes.grey;
            break;
        }

        let build_link = `[${data.build_id}](${output.PERMALINK})`;
        let build_details = `*Skipped Build ID ${build_link}*`;
        if (data.build_status != 'skipped') {
          build_details = DEDENT `
          - **Build ID**: ${build_link}
          - **Commit Author**: [${data.commit.author_name}](${data.commit.author_url})
          - **Started**: ${build_dates.start.toLocaleString('UTC',dateOptions)}
          - **Finished**: ${build_dates.finish.toLocaleString('UTC',dateOptions)}`;
        }
        output.FIELDS.push({
          name: `${build_emote} ${truncate(data.build_stage)}: ${truncate(data.build_name)}`,
          value: build_details
        });
        break;

      case 'Fake Error':
        console.log('# Invoked a Fake Error response.');
        output.DESCRIPTION = data.fake.error;
        break;

      case 'Known Error':
        output.COLOR = ColorCodes.error;
        output.TITLE = 'Error Processing HTTP Request';
        output.DESCRIPTION = data.message;

        if (data.body) {
          output.FIELDS.push({
            name: 'Received Data',
            value: truncate(data.body, StrLen.field_value)
          });
        }

        break;

      default:
        // TODO
        console.log('# Unhandled case! ', type);
        output.TITLE = `Type: ${type}`;
        output.DESCRIPTION = `This feature is not yet implemented`;

        output.FIELDS.push({
          name: 'Received Data',
          value: truncate(JSON.stringify(data), StrLen.json)
        });

        break;
    }
  } catch (e) {
    console.log('Error Context: processing data of an HTTP request. Type: ' + type);
    console.error(e);

    output.COLOR = ColorCodes.error;
    output.TITLE = 'Error Reading HTTP Request Data: ' + type;
    output.DESCRIPTION = e.message;
  }

  // Send data via webhook
  if (!skipped) {
    sendData(output);
  }
}

function sendData(input) {

  console.log('sending...');

  let embed = {
    color: input.COLOR,
    author: {
      name: input.USERNAME,
      icon_url: input.AVATAR_URL
    },
    title: input.TITLE,
    url: input.PERMALINK,
    description: input.DESCRIPTION,
    fields: input.FIELDS || {},
    timestamp: input.TIME || new Date(),
    footer: input.FOOTER || {
      icon_url: CONFIG.bot.icon_url,
      text: CONFIG.bot.name
    }
  };

  // Only send data if client is ready
  if (CLIENT != null && CLIENT.status == 0 && HOOK != null) {

    HOOK.send('', { embeds: [embed] })
      .then((message) => console.log(`Sent embed`))
      .catch(shareDiscordError(null, `[sendData] Sending an embed via WebHook: ${HOOK.name}`));
  } else {
    storedData.push(embed);
  }
}


// Custom Errors
function MyError(message) {
  this.name = 'MyError';
  this.message = message || 'Default Message';
  this.stack = (new Error()).stack;
}
MyError.prototype = Object.create(Error.prototype);
MyError.prototype.constructor = MyError;


/* A function that should use the appropriate decryption scheme for the specified webhook source
 * [Twitter] uses HMAC SHA-256 on a secret+payload, which should be compared to base-64 encoded headers[X-Twitter-Webhooks-Signature]
 * https://dev.twitter.com/webhooks/securing
 * [GitLab] simply sends the user-specified token which should be at least compared in a timing-safe fashion
 * https://gitlab.com/gitlab-org/gitlab-ce/issues/18256
 */
//function decrypt(headers) {
// Set up our secure token checking object
//const HMAC = CRYPTO.createHmac( 'sha256', process.env.GITLAB_TOKEN );
// Hash the data
//HMAC.update(headers['X-Gitlab-Token'], 'base64');
// Verify the hash
//console.log(hmac.digest('base64'));
//return CRYPTO.timingSafeEqual(hmac.digest('base64'), b);
//return false;
//}


/* ============================================
 * Bot Commands
 * ========================================= */
const SAMPLE = {
  build: { type: 'Build Hook', filename: 'sample/build.json' },
  issue: { type: 'Issue Hook', filename: 'sample/issue.json' },
  merge: { type: 'Merge Request Hook', filename: 'sample/merge.json' },
  merge_request: { type: 'Merge Request Hook', filename: 'sample/merge.json' },
  commit_comment: { type: 'Note Hook', filename: 'sample/note-commit.json' },
  issue_comment: { type: 'Note Hook', filename: 'sample/note-issue.json' },
  merge_comment: { type: 'Note Hook', filename: 'sample/note-merge.json' },
  snippet: { type: 'Note Hook', filename: 'sample/note-snippet.json' },
  pipeline: { type: 'Pipeline Hook', filename: 'sample/pipeline.json' },
  push: { type: 'Push Hook', filename: 'sample/push.json' },
  tag: { type: 'Tag Push Hook', filename: 'sample/tag.json' },
  wiki: { type: 'Wiki Page Hook', filename: 'sample/wiki.json' },
  unrelated: { type: 'Unrelated', filename: 'sample/unrelated.json' },
  fake_error: { type: 'Fake Error', filename: 'sample/unrelated.json' }
};

// Custom Error Handlers for DiscordAPI
// Reply to the message with an error report
function replyWithDiscordError(msg) {
  // Return a function so that we can simply replace console.error with replyWithDiscordError(msg)
  return function(e) {
    if (msg) {
      msg.reply(`encountered an error from DiscordAPI: ${e.message}`)
        .then((m) => { console.log(`Informed ${msg.author} of the API error: ${e.message}`) })
        .catch(console.error);
    }
    console.error(e);
  };
}
// Mention User and send report to Debug Channel
function shareDiscordError(user, context) {
  // Return a function so that we can simply replace console.error with shareDiscordError(user)
  let channel = CLIENT.channels.get(CONFIG.bot.debug_channel_id);
  return function(e) {
    console.log('Error Context: ' + context);
    console.error(e);
    if (user && channel) {
      channel.send(`${user} encountered an error from DiscordAPI...\nContext: ${context}\nError: ${e.message}`)
        .then((m) => { console.log(`[Via Debug Channel] Informed ${user} of the API Error ${e.code} during ${context}`) })
        .catch(shareDiscordErrorFromSend(e, context, `[ERROR] Sending error message to ${user} in ${channel}`));
    } else if (channel) {
      channel.send(`Someone encountered an error from DiscordAPI...\nContext: ${context}\nError: ${e.message}`)
        .then((m) => { console.log(`[Via Debug Channel] Reported an API Error ${e.code} during ${context}`) })
        .catch(shareDiscordErrorFromSend(e, context, `[ERROR] Sending error message to ${channel}`));
    }
  }
}
// In case we cannot send messages, try going through the webhook
function shareDiscordErrorFromSend(originalError, originalContext, context) {
  return function(e) {
    console.log('Error Context: ' + context);
    console.error(e);
    if (HOOK) {
      HOOK.send(`[${CONFIG.bot.name}] encountered an error...\nInitial Context: ${originalContext}\nInitial Error: ${originalError.message}\nSubsequent Context: ${context}\nSubsequent Error: ${e.message}`)
        .then((m) => console.log(`Sent an error report via webhook`))
        .catch(console.error);
    }
  }
}


const COMMANDS = {

  status: function(msg, arg) {
    HOOK.send('', { embeds: [getStatusEmbed('status')] })
      .then((message) => console.log(`Sent status embed`))
      .catch(shareDiscordError(null, `[STATUS] Sending status embed [status] via WebHook: ${HOOK.name}`));
  },

  debug: function(msg, arg) {
    if (msg.author.id == CONFIG.bot.master_user_id) {
      let setting = (arg[0]) ? arg[0] : null;
      if (setting == null || setting.toLowerCase() == 'true') {
        IS_DEBUG_MODE = true;
        msg.reply(`Debug Mode Is ON`)
          .then((m) => { console.log(`Informed ${msg.author} that debug mode is on`) })
          .catch(shareDiscordError(msg.author, `[DEBUG:${setting}] Sending a reply [Debug Mode Is ON] to ${msg.author} in ${msg.channel}`));
      } else if (setting.toLowerCase() == 'false') {
        IS_DEBUG_MODE = false;
        msg.reply(`Debug Mode Is OFF`)
          .then((m) => { console.log(`Informed ${msg.author} that debug mode is off`) })
          .catch(shareDiscordError(msg.author, `[DEBUG:${setting}] Sending a reply [Debug Mode Is OFF] to ${msg.author} in ${msg.channel}`))
      } else {
        msg.reply(`Not a valid argument. Please specify true or false to turn debug mode on or off.`)
          .then((m) => { console.log(`Informed ${msg.author} that debug argument was invalid`) })
          .catch(shareDiscordError(msg.author, `[DEBUG:${setting}] Sending a reply [Argument Must Be True or False] to ${msg.author} in ${msg.channel}`));
      }
    }
  },

  clear: function(msg, arg) {
    // Get the number of messages (first arg)
    let num = (arg[0]) ? parseInt(arg[0]) : 0;
    if (isNaN(num) || num < 2 || num > 100) {
      // Inform the user that this number is invalid
      msg.reply(`You must specify a number between 2 and 100, inclusive.`)
        .then((m) => { console.log(`Informed ${msg.author} that the num messages to delete was invalid`) })
        .catch(shareDiscordError(msg.author, `[CLEAR:${num}] Sending a reply [Argument Must Be >= 2 AND <= 100] to ${msg.author} in ${msg.channel}`));
      // End
      return;
    }

    // Get the channel mentioned if it was mentioned, otherwise set to current channel
    let channel = (msg.mentions.channels.size > 0) ? msg.mentions.channels.first() : msg.channel;
    if (channel.type !== 'text') {
      // Inform the user that this channel is invalid
      msg.reply(`You must specify a text channel.`)
        .then((m) => { console.log(`Informed ${msg.author} that the channel ${channel} was an invalid type ${channel.type}`) })
        .catch(shareDiscordError(msg.author, `[CLEAR:${channel}] Sending a reply [Please Specify a TextChannel] to ${msg.author} in ${msg.channel}`));
      // End
      return;
    }

    //console.log(channel.messages.size); // Only retrieves number of messages in cache (since bot started)

    // TODO: Find a better way of pre-checking number of messages available, maybe recursively?
    /*let total = null;
    channel.fetchMessages() // Limited to 50 at a time, so do this 4 times to get 200
      .then( (collection) => { 
        total = collection.size; 
      } )
      .catch( shareDiscordError(msg.author, `[CLEAR] Fetching messages in channel ${channel}`) );    
    // Set the number of messages to no more than the size of the channel's message collection
    num = Math.min(num, total);
    if (num < 2) {
      // Inform the user that there are not enough messages in the channel to bulk delete
      msg.reply(`The channel ${channel} only has ${total} messages. Needs at least 3 messages for bulk delete to work.`)
        .then( (m) => {console.log(`Informed ${msg.author} that the channel ${channel} had too few messages`)} )
        .catch( shareDiscordError(msg.author, `[CLEAR:${num},${channel}] Sending a reply [Message Count Mismatch] to ${msg.author} in ${msg.channel}`) );
      // End
      return;
    }*/

    // Check if author is allowed to manage messages (8192 or 0x2000) in specified channel
    if (channel.permissionsFor(msg.author).has(8192)) {
      // Bulk Delete, auto-ignoring messages older than 2 weeks
      channel.bulkDelete(num, true)
        .then((collection) => {
          msg.reply(`Successfully deleted ${collection.size} recent messages (from within the past 2 weeks) in ${channel}`)
            .then((m) => console.log(`Confirmed success of bulk delete in channel ${channel}`))
            .catch(shareDiscordError(msg.author, `[CLEAR:${num},${channel}] Sending a reply [Success] to ${msg.author} in ${msg.channel}`))
        })
        .catch(shareDiscordError(msg.author, `[CLEAR:${num},${channel}] Using bulkDelete(${num}, filterOld=true) in ${channel}`));

    } else {
      // Inform the user that they are not permitted
      msg.reply(`Sorry, but you are not permitted to manage messages in ${channel}`)
        .then((m) => { console.log(`Informed ${msg.author} that they do not have permission to manage messages in ${channel}`) })
        .catch(shareDiscordError(msg.author, `[CLEAR:${num},${channel}] Sending a reply [User Not Permitted] to ${msg.author} in ${msg.channel}`));
    }
  },

  embed: function(msg, arg) {
    let key = (arg[0]) ? arg[0] : '';

    if (key != '' && SAMPLE.hasOwnProperty(key)) {
      FS.readFile(SAMPLE[key].filename, 'utf8', function(err, data) {
        if (err) {
          console.log('Error Context: Reading a file ' + key);
          console.error(err);
          msg.reply(`There was a problem loading the sample data: ${key}`)
            .catch(shareDiscordError(msg.author, `[EMBED:${key}] Sending a reply [Error Reading File] to ${msg.author} in ${msg.channel}`));
        } else {
          msg.reply(`Sending a sample embed: ${arg}`)
            .catch(shareDiscordError(msg.author, `[EMBED:${key}] Sending a reply [Success] to ${msg.author} in ${msg.channel}`));
          processData(SAMPLE[key].type, JSON.parse(data));
        }
      });
    } else {
      msg.reply(`Not a recognized argument`)
        .catch(shareDiscordError(msg.author, `[EMBED:null] Sending a reply [Invalid Argument] to ${msg.author} in ${msg.channel}`));
    }
  },

  disconnect: function(msg, arg) {
    let time = (arg[0]) ? parseInt(arg[0]) : 5000;
    time = (isNaN(time)) ? 5000 : time;
    time = Math.min(Math.max(time, 5000), 3600000);

    // Verify that this user is allowed to disconnect the bot
    if (msg.author.id == CONFIG.bot.master_user_id) {
      userTimerEnabled = true;

      msg.reply(`Taking bot offline for ${time} ms.  Any commands will be ignored until after that time, but the server will still attempt to listen for HTTP requests.`)
        .catch(shareDiscordError(msg.author, `[DISCONNECT:${time}] Sending a reply [Success] to ${msg.author} in ${msg.channel}`));

      CLIENT.destroy()
        .then(() => {
          setTimeout(() => {
            userTimerEnabled = false;
            console.log('finished user-specified timeout');
          }, time);
        })
        .catch(shareDiscordError(msg.author, `[DISCONNECT] Destroying the client session`));

    } else {
      msg.reply(`You're not allowed to disconnect the bot!`)
        .catch(shareDiscordError(msg.author, `[DISCONNECT] Sending a reply [Not Permitted] to ${msg.author} in ${msg.channel}`));
    }
  },

  ping: function(msg, arg) {
    msg.channel.send('pong')
      .catch(shareDiscordError(msg.author, `[PING] Sending a message to ${msg.channel}`));
  },

  test: function(msg, arg) {
    msg.reply('Sending a sample embed')
      .catch(shareDiscordError(msg.author, `[TEST] Sending a reply to ${msg.author} in ${msg.channel}`));

    let embed = {
      color: 3447003,
      author: {
        name: CLIENT.user.username,
        icon_url: CLIENT.user.avatarURL
      },
      title: 'This is an embed',
      url: 'http://google.com',
      description: `[abcdef](http://google.com 'A title') A commit message... -Warped2713`,
      fields: [{
          name: 'Fields',
          value: 'They can have different fields with small headlines.'
        },
        {
          name: 'Masked links',
          value: 'You can put [masked links](http://google.com) inside of rich embeds.'
        },
        {
          name: 'Markdown',
          value: 'You can put all the *usual* **__Markdown__** inside of them.'
        }
      ],
      timestamp: new Date(),
      footer: {
        icon_url: CLIENT.user.avatarURL,
        text: '© Example'
      }
    };

    HOOK.send('', { embeds: [embed] })
      .then((message) => console.log(`Sent test embed`))
      .catch(shareDiscordError(msg.author, `[TEST] Sending a message via WebHook ${HOOK.name}`));
  }

};

/* ============================================
 * Discord.JS Event Handlers
 * ========================================= */

// Status alert message embeds
const STATUS_EMBEDS = {
  status: {
    color: ColorCodes.default,
    title: 'Bot Status Update',
    description: "See getStatusEmbed",
    timestamp: new Date(),
    footer: { icon_url: CONFIG.bot.icon_url, text: CONFIG.bot.name }
  },
  ready: {
    color: ColorCodes.default,
    title: 'Bot Status Update',
    description: `${CONFIG.bot.name} is now online and ready to process commands`,
    timestamp: new Date(),
    footer: { icon_url: CONFIG.bot.icon_url, text: CONFIG.bot.name }
  },
  recovery: {
    color: ColorCodes.default,
    title: 'Bot Status Update',
    description: 'Default text',
    timestamp: new Date(),
    footer: { icon_url: CONFIG.bot.icon_url, text: CONFIG.bot.name }
  },
  rebooted: {
    color: ColorCodes.default,
    title: 'Bot Status Update',
    description: `${CONFIG.bot.name} has been restarted.  Any unprocessed data sent before this message will need to be resubmitted.`,
    timestamp: new Date(),
    footer: { icon_url: CONFIG.bot.icon_url, text: CONFIG.bot.name }
  },
  listening: {
    color: ColorCodes.default,
    title: 'Bot Status Update',
    description: `Ready to listen for HTTP requests`,
    timestamp: new Date(),
    footer: { icon_url: CONFIG.bot.icon_url, text: CONFIG.bot.name }
  }
};

/**
 * https://stackoverflow.com/a/9763769
 * @param {*} s number or string representing numerical value in ms
 * @returns {string} HH:MM:SS
 */
function msToTime(s) {
  // Pad to 2 or 3 digits, default is 2
  var pad = (n, z = 2) => ('00' + n).slice(-z);
  return pad(s / 3.6e6 | 0) + 'h:' + pad((s % 3.6e6) / 6e4 | 0) + 'm:' + pad((s % 6e4) / 1000 | 0) + '.' + pad(s % 1000, 3) + 's';
}

function getStatusEmbed(key) {
  if (STATUS_EMBEDS[key]) {
    STATUS_EMBEDS[key].timestamp = new Date();
    if (key == "status") {
      STATUS_EMBEDS[key].description = `${CONFIG.bot.name} has status code ${CLIENT.status} and uptime ${msToTime(CLIENT.uptime)}`;
    }
  }
  return STATUS_EMBEDS[key];
}

// The ready event is vital, it means that your bot will only start reacting to information
// from Discord _after_ ready is emitted
CLIENT.on('ready', () => {
  console.log(`${CONFIG.bot.name} is ready to receive data`);

  HOOK.send('', { embeds: [getStatusEmbed(readyMsg)] })
    .then((message) => console.log(`Sent ready embed`))
    .catch(shareDiscordError(null, `[onReady] Sending status embed [${readyMsg}] via WebHook: ${HOOK.name}`));

  if (disconnectHandled) {
    disconnectHandled = false;

    // Process stored data
    let numStored = storedData.length;
    let collectedEmbeds = [getStatusEmbed('recovery')];
    for (let i = 0; i < numStored; i++) {
      collectedEmbeds.push(storedData.pop());
    }
    collectedEmbeds[0].description = `Recovered ${collectedEmbeds.length} requests...`;
    // Send all the collected Embeds at once
    // NOTE: There is a chance that a request gets added to collectedEmbeds during this process, and won't be shared until the next time the bot recovers
    HOOK.send('', { embeds: collectedEmbeds })
      .then((message) => console.log(`Sent stored embeds`))
      .catch(shareDiscordError(null, `[onReady] Sending recovered embeds via WebHook: ${HOOK.name}`));

  } else {

    if (!app.listening) {
      // Start listening for HTTP requests
      app.listen(
        CONFIG.webhook.server.port,
        CONFIG.webhook.server.address,
        () => {
          console.log('Ready to listen at ', app.address());

          HOOK.send('', { embeds: [getStatusEmbed('listening')] })
            .then((message) => console.log(`Sent listening embed`))
            .catch(shareDiscordError(null, `[onListen] Sending status [listening] via WebHook: ${HOOK.name}`));
        });
    }

  }

});

// Create an event listener for messages
CLIENT.on('message', msg => {
  // Ignore messages from DMs, Gropu DMs, and Voice
  if (msg.channel.type !== 'text') return;

  // Only read message if it starts with command prefix
  if (msg.content.startsWith(CONFIG.bot.prefix)) {

    // Parse cmd and args
    let [cmd, ...arg] = msg.content.substring(CONFIG.bot.prefix.length).toLowerCase().split(' ');

    // Only process command if it is recognized
    if (COMMANDS.hasOwnProperty(cmd)) {
      COMMANDS[cmd](msg, arg);
    }

  }
});

CLIENT.on('disconnect', closeEvent => {
  let d = new Date();
  console.log(d.toLocaleString());

  if (closeEvent) {
    console.log(CONFIG.bot.name + ' went offline with code ' + closeEvent.code + ': ' + closeEvent.reason);
    console.log('Exiting...');
  } else {
    console.log(`${CONFIG.bot.name} went offline with unknown code`);
  }
});

CLIENT.on('reconnecting', () => {
  let d = new Date();
  console.log(d.toLocaleString());
  console.log(`${CONFIG.bot.name} is attempting to reconnect`);
});

CLIENT.on('warn', warn => {
  let d = new Date();
  console.log(d.toLocaleString());
  if (warn) {
    console.log('Warning: ' + warn);
  }
});

CLIENT.on('error', error => {
  let d = new Date();
  console.log(d.toLocaleString());
  if (error) {
    console.log('Error: ' + error.message);
  } else {
    console.log('Unknown error');
  }
});


/* ============================================
 * Log our bot into Discord
 * ========================================= */
console.log('Logging in...');
// Log our bot in
CLIENT.login(BOT_SECRET);