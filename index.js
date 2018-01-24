/*
*   GitHub to S3 Pusher: an AWS Lambda function, triggered by Github Webhook via SNS, to
*   sync changes on commit to an S3 bucket.
*
*   Project: https://github.com/kevintech/github-deploy-s3
*   Author: Kevin Herrarte
*   E-Mail: hello@kevintech.ninja
*   Version: 1.0, Janury 2018 
*   Based on: https://github.com/nytlabs/github-s3-deploy
*/

const S3_BUCKET_NAME = ""; //your destination s3 bucket name
const GITHUB_TOKEN = ""; //your token generated on https://github.com/settings/tokens 
var async = require("async");
var AWS = require("aws-sdk");
var GitHubApi = require("github");
var mime = require("mime");
var githubClient = new GitHubApi({
    version: "3.0.0",
    debug: false,
    protocol: "https",
    host: "api.github.com"
});
var awsS3Client = new AWS.S3();
var regexRepoName = new RegExp(/([^\/]*)/);

exports.handler = function(event, context) {
    if (GITHUB_TOKEN==null || GITHUB_TOKEN.length===0){
        context.fail("Couldn't retrieve github token. Exiting.");
        return;
    }
    
    if (!isGitPushEvent(event)) {
        console.log("Message was not a github push message. Exiting.");
        context.succeed();
        return;
    }
    
    var githubEvent = event.Records[0].Sns.Message;
    var eventObj = JSON.parse(githubEvent);
    var found = regexRepoName.exec(eventObj.repository.full_name);
    var user = found[0];
    var repo = eventObj.repository.name;
    var commitId = eventObj.head_commit.id;
    var commitReference = "/repos/"+user+"/"+repo+"/commits/"+commitId
    var commitInfo = { "user": user, "repo": repo, "sha": commitId };
    console.log("--- Push message received. Will get code from: ", commitReference);
    githubClient.authenticate({
        type: "oauth",
        token: GITHUB_TOKEN
    });
    githubClient.repos.getCommit(commitInfo, function(err, result){
        console.log("result:", result);
        if(err) {
            context.fail("Failed to get commit: ", err);
            return;
        }
        
        parseCommit(result, user, repo, function(err){
            if(err) {
                context.fail("Parsing the commit failed: " + err);
                return;
            }
            console.log("Commit parsed and synced (mostly?) successfully.")
            context.succeed();
        });
    });
};

function isGitPushEvent(event) {
    var mesgattr = event.Records[0].Sns.MessageAttributes;
    return ((mesgattr.hasOwnProperty("X-Github-Event")) && (mesgattr["X-Github-Event"].Value == "push"));
}

function parseCommit(resobj, user, repo, callback){
    if (typeof resobj.files==="undefined" || !resobj.files || resobj.length<=0) {
        console.log("Commit at " + resobj.html_url + " had no files. Exiting.");
        callback(new Error("No files in commit object")); // commit processing is done
        return;
    }
    
    async.each(resobj.files, processFile, function(err) {
        console.log("I should be all done now. Here's what error says: ", err)
        callback(err); // commit processing is done
    });
    
    function processFile(file, fileCallback) {
        if(file.status == "removed") {
            s3delete(file.filename, fileCallback);
        }
        else if(file.status == "renamed") {
            s3rename(file, user, repo, fileCallback);
        }
        else
        {
            s3put(file, user, repo, fileCallback);
        }
    }
}

function s3rename(file, user, repo, cb) {
    async.waterfall([
        function calldeleter(wfcb) {
            s3delete(file.previous_filename, wfcb);
        },
        function callputter(wfcb) {
            s3put(file, user, repo, wfcb);
        }
    ],
    function done(err) {
        cb(err);
    });
}

function s3delete(filename, cb){
    console.log("- Deleting ", filename);
    var params = { Bucket: S3_BUCKET_NAME, Key: filename };
    async.waterfall([callDelete], done);
    
    function callDelete(callback) {
        awsS3Client.deleteObject(params, callback);
    }
    
    function done(err) {
        if(err) {
            console.log("Couldn't delete " + filename + ": " + err);
        }
        else {
            console.log("Deleted " + filename + " from " + S3_BUCKET_NAME);
        }
        cb(); //not passing err here because I don't want to short circuit processing the rest of the array
    }
}

function s3put(file, user, repo, cb){
    console.log("+ Storing " + file.filename);
    async.waterfall([downloadFile, storeFile], done);

    function downloadFile(callback) {
        console.log("...downloading " + file.filename);
        var params = { user: user, repo: repo, sha: file.sha};
        githubClient.gitdata.getBlob(params, callback);
    }
    
    function storeFile(result, callback) {
        var blob = new Buffer(result.content, "base64");
        var mimetype = mime.lookup(file.filename);
        var isText = (mime.charsets.lookup(mimetype) == "UTF-8");
        if (isText) {
            blob = blob.toString("utf-8");
        }
        console.log("...putting " + file.filename + " of type " + mimetype);
        var putparams = { Bucket: S3_BUCKET_NAME, Key: file.filename, Body: blob, ContentType: mimetype, ACL: "public-read"};
        awsS3Client.putObject(putparams, callback);
    }
    
    function done(err) {
        if (err){
            console.log("Couldn't store " + file.filename + " in bucket " + S3_BUCKET_NAME + "; " + err);
        }
        else {
            console.log("Saved " + file.filename + " to " + S3_BUCKET_NAME + " successfully.");                     
        }
        
        cb(); //not passing err here because I don't want to short circuit processing the rest of the array
    }
}